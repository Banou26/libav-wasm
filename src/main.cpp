#include <emscripten.h>
#include <emscripten/val.h>
#include <emscripten/bind.h>
#include <vector>
#include <sstream>
#include <string>
#include <cstring>  // for memcpy
#include <numeric>  // std::accumulate

extern "C" {
  #include <libavformat/avio.h>
  #include <libavcodec/avcodec.h>
  #include <libavformat/avformat.h>
}

using namespace emscripten;
using namespace std;

static inline std::string ffmpegErrStr(int errnum) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(errnum, buf, sizeof(buf));
  return std::string(buf);
}

typedef struct MediaInfo {
  std::string formatName;
  std::string mimeType;
  double duration;
  std::string video_mime_type;
  std::string audio_mime_type;
} MediaInfo;

typedef struct IOInfo {
  MediaInfo input;
  MediaInfo output;
} IOInfo;

typedef struct Attachment {
  std::string filename;
  std::string mimetype;
  emscripten::val data;
} Attachment;

typedef struct SubtitleFragment {
  int streamIndex;
  bool isHeader;
  emscripten::val data;
  std::string language;
  std::string title;
  long start;
  long end;
} SubtitleFragment;

typedef struct InitResult {
  std::vector<emscripten::val> data;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;
  IOInfo info;
} InitResult;

typedef struct ReadResult {
  std::vector<emscripten::val> data;
  std::vector<SubtitleFragment> subtitles;
  bool finished;
} ReadResult;

class Remuxer {
public:
  AVIOContext* input_avio_context = nullptr;
  AVIOContext* output_avio_context = nullptr;
  AVFormatContext* output_format_context = nullptr;
  AVFormatContext* input_format_context = nullptr;
  uint8_t* input_avio_buffer = nullptr;
  uint8_t* output_avio_buffer = nullptr;

  int64_t currentOffset = 0;
  int64_t input_length = 0;

  int buffer_size;
  int video_stream_index;
  int number_of_streams;
  int* streams_list = nullptr;

  // For partial segments
  bool is_header = true;  // first keyframe triggers segment start
  bool first_frame = true;
  double prev_duration = 0;
  double prev_pts = 0;
  long   prev_pos = 0;
  double duration = 0;
  double pts = 0;
  long   pos = 0;

  // Some track-level info for building correct mime types
  std::string video_mime_type;
  std::string audio_mime_type;

  std::vector<emscripten::val> write_vector;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;

  emscripten::val resolved_promise = val::undefined();
  emscripten::val read_data_function = val::undefined();

  AVPacket* packet = nullptr;
  bool has_seen_non_keyframe = false;
  bool has_outputed_first_keyframe = false;

  Remuxer(emscripten::val options) {
    resolved_promise = options["resolvedPromise"];
    input_length = options["length"].as<float>();
    buffer_size = options["bufferSize"].as<int>();
  }

  ~Remuxer() {
    destroy();
  }

  std::string parse_mp4a_mime_type(AVCodecParameters* in_codecpar) {
    switch (in_codecpar->profile) {
      case FF_PROFILE_AAC_LOW:  return "mp4a.40.2";   // AAC-LC
      case FF_PROFILE_AAC_HE:   return "mp4a.40.5";   // HE-AAC / AAC+ (SBR)
      case FF_PROFILE_AAC_HE_V2:return "mp4a.40.29";  // HE-AAC v2 / AAC++ (SBR+PS)
      case FF_PROFILE_AAC_LD:   return "mp4a.40.23";  // AAC-LD
      case FF_PROFILE_AAC_ELD:  return "mp4a.40.39";  // AAC-ELD
      default:                  return "mp4a.40.unknown";
    }
  }

  std::string parse_h264_mime_type(AVCodecParameters* in_codecpar) {
    if (!in_codecpar->extradata || in_codecpar->extradata_size < 4) {
      return "avc1.invalid";
    }
    // extradata[1]=profile, [2]=constraints, [3]=level
    uint8_t profile = in_codecpar->extradata[1];
    uint8_t constraints = in_codecpar->extradata[2];
    uint8_t level = in_codecpar->extradata[3];

    char mime_type[64] = {0};
    sprintf(mime_type, "avc1.%02x%02x%02x", profile, constraints, level);
    return mime_type;
  }


  std::string parse_h265_mime_type(AVCodecParameters* in_codecpar) {
    if (!in_codecpar->extradata || in_codecpar->extradata_size < 3) {
      return "hev1.invalid";
    }
    // Just a placeholder for demonstration
    return "hev1.1.6.L93";
  }

  InitResult init(emscripten::val read_function) {
    read_data_function = read_function;

    has_seen_non_keyframe = false;
    write_vector.clear();
    attachments.clear();
    subtitles.clear();
    video_mime_type.clear();
    audio_mime_type.clear();

    input_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    input_avio_context = avio_alloc_context(
      input_avio_buffer,
      buffer_size,
      0,                       // not writing
      this,                    // opaque
      &Remuxer::avio_read,     // custom read
      nullptr,                 // no write
      &Remuxer::avio_seek      // custom seek
    );
    input_format_context = avformat_alloc_context();
    input_format_context->pb = input_avio_context;

    int ret = avformat_open_input(&input_format_context, NULL, nullptr, nullptr);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not open input: " + ffmpegErrStr(ret)
      );
    }

    ret = avformat_find_stream_info(input_format_context, nullptr);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not find stream info: " + ffmpegErrStr(ret)
      );
    }

    output_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    output_avio_context = avio_alloc_context(
      output_avio_buffer,
      buffer_size,
      1,                     // writing
      this,
      nullptr,               // no read
      &Remuxer::avio_write,
      nullptr
    );

    avformat_alloc_output_context2(&output_format_context, NULL, "mp4", NULL);
    output_format_context->pb = output_avio_context;

    number_of_streams = input_format_context->nb_streams;
    streams_list = (int*)av_calloc(number_of_streams, sizeof(*streams_list));

    if (!streams_list) {
      throw std::runtime_error("Could not allocate streams_list");
    }

    int out_index = 0;
    for (int i = 0; i < number_of_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      AVCodecParameters* in_codecpar = in_stream->codecpar;

      // We handle attachments separately
      if (in_codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
        // Extract the attachment info
        Attachment attachment;
        AVDictionaryEntry* filename = av_dict_get(in_stream->metadata, "filename", NULL, 0);
        if (filename) attachment.filename = filename->value;
        AVDictionaryEntry* mimetype = av_dict_get(in_stream->metadata, "mimetype", NULL, 0);
        if (mimetype) attachment.mimetype = mimetype->value;

        // The actual attachment bytes are in extradata
        attachment.data = emscripten::val(
          emscripten::typed_memory_view(
            in_codecpar->extradata_size,
            in_codecpar->extradata
          )
        );
        attachments.push_back(std::move(attachment));

        streams_list[i] = -1;
        continue;
      }

      // We handle subtitles separately
      if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        // It's a subtitle header
        SubtitleFragment subtitle_fragment;
        subtitle_fragment.streamIndex = i;
        subtitle_fragment.isHeader = true;
        subtitle_fragment.start = 0;
        subtitle_fragment.end = 0;
        // Try reading some metadata
        AVDictionaryEntry* lang = av_dict_get(in_stream->metadata, "language", NULL, 0);
        if (lang) subtitle_fragment.language = lang->value;
        AVDictionaryEntry* title = av_dict_get(in_stream->metadata, "title", NULL, 0);
        if (title) subtitle_fragment.title = title->value;
        // The extradata is the "header"
        subtitle_fragment.data = emscripten::val(
          emscripten::typed_memory_view(
            in_codecpar->extradata_size,
            in_codecpar->extradata
          )
        );
        subtitles.push_back(std::move(subtitle_fragment));

        // Mark not to be remuxed in the output container (mp4)
        streams_list[i] = -1;
        continue;
      }

      // Otherwise, we consider video or audio
      if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        video_stream_index = i;
        if (in_codecpar->codec_id == AV_CODEC_ID_H264) {
          video_mime_type = parse_h264_mime_type(in_codecpar);
        } else if (in_codecpar->codec_id == AV_CODEC_ID_H265) {
          video_mime_type = parse_h265_mime_type(in_codecpar);
        }
      }
      if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        if (in_codecpar->codec_id == AV_CODEC_ID_AAC) {
          audio_mime_type = parse_mp4a_mime_type(in_codecpar);
        }
      }

      // Create new output stream
      AVStream* out_stream = avformat_new_stream(output_format_context, nullptr);
      if (!out_stream) {
        throw std::runtime_error("Could not allocate an output stream");
      }
      int cpRet = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
      if (cpRet < 0) {
        throw std::runtime_error(
          "Could not copy codec parameters: " + ffmpegErrStr(cpRet)
        );
      }
      streams_list[i] = out_index++;
    }

    // Step E: set fragmentation flags
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "strict", "experimental", 0);
    av_dict_set(&opts, "c", "copy", 0);
    av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

    // Step F: write the MP4 header (this triggers avio_write => data -> data)
    ret = avformat_write_header(output_format_context, &opts);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not write header: " + ffmpegErrStr(ret)
      );
    }

    // Build IOInfo
    IOInfo infoObj;
    infoObj.input.formatName  = input_format_context->iformat->name ? input_format_context->iformat->name : "";
    infoObj.input.mimeType    = input_format_context->iformat->mime_type ? input_format_context->iformat->mime_type : "";
    infoObj.input.duration    = (double)input_format_context->duration / (double)AV_TIME_BASE;
    infoObj.input.video_mime_type = video_mime_type;
    infoObj.input.audio_mime_type = audio_mime_type;

    infoObj.output.formatName = output_format_context->oformat->name ? output_format_context->oformat->name : "";
    infoObj.output.mimeType   = output_format_context->oformat->mime_type ? output_format_context->oformat->mime_type : "";
    infoObj.output.duration   = 0.0; // we haven’t written frames yet
    infoObj.output.video_mime_type = video_mime_type;
    infoObj.output.audio_mime_type = audio_mime_type;

    // Return everything the caller needs from init
    InitResult result;
    result.data = write_vector;
    result.attachments = attachments;
    result.subtitles = subtitles;
    result.info = infoObj;

    read_data_function = val::undefined();

    return result;
  }

  // int process_packet() {
  //   resolved_promise.await();
  //   printf("process \n");
  //   int ret;

  //   AVStream* in_stream  = input_format_context->streams[packet->stream_index];
  //   if (packet->stream_index >= number_of_streams
  //       || streams_list[packet->stream_index] < 0) {
  //     // not an included stream, drop
  //     av_packet_free(&packet);
  //     return 1;
  //   }
  //   printf("process 2 \n");

  //   // If it's a subtitle packet
  //   if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
  //     SubtitleFragment subtitle_fragment;
  //     subtitle_fragment.streamIndex = packet->stream_index;
  //     subtitle_fragment.isHeader = false;
  //     subtitle_fragment.start = packet->pts;
  //     subtitle_fragment.end   = subtitle_fragment.start + packet->duration;
  //     // The actual subtitle data
  //     subtitle_fragment.data = emscripten::val(
  //       emscripten::typed_memory_view(
  //         packet->size,
  //         packet->data
  //       )
  //     );
  //     subtitles.push_back(std::move(subtitle_fragment));
  //     printf("process 3 \n");

  //     av_packet_free(&packet);
  //     return 1;
  //   }
  //   printf("process 4 \n");

  //   // If it's audio or video, we remux
  //   AVStream* out_stream = output_format_context->streams[streams_list[packet->stream_index]];

  //   // If video, accumulate durations
  //   if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
  //     duration += packet->duration * av_q2d(in_stream->time_base);
  //   }

  //   bool is_keyframe = (packet->flags & AV_PKT_FLAG_KEY) != 0;

  //   // rescale timestamps
  //   av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
  //   printf("process 5 \n");

  //   // Write to output
  //   ret = av_interleaved_write_frame(output_format_context, packet);
  //   if (ret < 0) {
  //     printf("err \n");
  //     printf("Error writing frame: %s\n", ffmpegErrStr(ret).c_str());
  //     av_packet_free(&packet);
  //     return 2;
  //   }
  //   printf("process 6 \n");

  //   av_packet_free(&packet);
  //   printf("process 7 \n");

  //   return 0;
  // }

  // ReadResult read(emscripten::val read_function) {
  //   printf("read \n");
  //   resolved_promise.await();

  //   read_data_function = read_function;

  //   write_vector.clear();
  //   subtitles.clear();

  //   bool finished = false;
  //   printf("read2 \n");

  //   while (true) {
  //     printf("read3 \n");
  //     int ret;
  //     int process_ret;

  //     if (packet != nullptr) {
  //       printf("read3.5 \n");
  //       process_ret = process_packet();
  //       packet = nullptr;
  //     }
  //     printf("read4 \n");
  //     if (process_ret == 2) break;
  //     if (process_ret == 1) continue;
  //     printf("read5 \n");

  //     packet = av_packet_alloc();
  //     ret = av_read_frame(input_format_context, packet);

  //     if (ret < 0) {
  //       // if ret == AVERROR_EOF, we finalize
  //       if (ret == AVERROR_EOF) {
  //         // flush + trailer
  //         avio_flush(output_format_context->pb);
  //         av_write_trailer(output_format_context);
  //         finished = true;
  //       }
  //       av_packet_free(&packet);
  //       break;
  //     }
  //     printf("read6 \n");

  //     bool is_keyframe = (packet->flags & AV_PKT_FLAG_KEY) != 0;
  //     if (!first_packet && is_keyframe) {
  //       break;
  //     }
  //     first_packet = false;
  //     printf("read7 \n");
  //     process_ret = process_packet();
  //     packet = nullptr;
  //     printf("read8 \n");
  //     if (process_ret == 2) break;
  //     if (process_ret == 1) continue;
  //     printf("read9 \n");
  //   }

  //   printf("read10 \n");
  //   ReadResult result;
  //   result.data = write_vector;
  //   result.subtitles = subtitles;
  //   result.finished = finished;

  //   read_data_function = val::undefined();
  //   return result;
  // }

  int process_packet() {
    // AVPacket* packet = av_packet_alloc();
    // int ret = av_read_frame(input_format_context, packet);
    // if (ret < 0) {
    //   // if ret == AVERROR_EOF, we finalize
    //   if (ret == AVERROR_EOF) {
    //     // flush + trailer
    //     avio_flush(output_format_context->pb);
    //     av_write_trailer(output_format_context);
    //     av_packet_free(&packet);
    //     // finished = true;
    //     return 3;
    //   }
    //   av_packet_free(&packet);
    //   return 2;
    // }

    int ret;

    AVStream* in_stream  = input_format_context->streams[packet->stream_index];
    if (packet->stream_index >= number_of_streams
        || streams_list[packet->stream_index] < 0) {
      // not an included stream, drop
      av_packet_free(&packet);
      return 1;
    }

    // If it's a subtitle packet
    if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
      SubtitleFragment subtitle_fragment;
      subtitle_fragment.streamIndex = packet->stream_index;
      subtitle_fragment.isHeader = false;
      subtitle_fragment.start = packet->pts;
      subtitle_fragment.end   = subtitle_fragment.start + packet->duration;
      // The actual subtitle data
      subtitle_fragment.data = emscripten::val(
        emscripten::typed_memory_view(
          packet->size,
          packet->data
        )
      );
      subtitles.push_back(std::move(subtitle_fragment));

      av_packet_free(&packet);
      return 1;
    }

    // If it's audio or video, we remux
    AVStream* out_stream = output_format_context->streams[streams_list[packet->stream_index]];

    // If video, accumulate durations
    if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
      duration += packet->duration * av_q2d(in_stream->time_base);
    }

    bool is_keyframe = (packet->flags & AV_PKT_FLAG_KEY) != 0;

    // rescale timestamps
    av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

    // Write to output
    ret = av_interleaved_write_frame(output_format_context, packet);
    if (ret < 0) {
      printf("Error writing frame: %s\n", ffmpegErrStr(ret).c_str());
      av_packet_free(&packet);
      return 2;
    }

    if (is_keyframe && !is_header) {
      // We reached the next keyframe => let's return 2 to form a chunk
      // If we are still in "header" mode (the very first keyframe after init),
      // then we just switch off that mode and keep reading. 
      if (is_header) {
        is_header = false;
      } else {
        // we have ended a chunk 
        av_packet_free(&packet);
        return 2;
      }
    }

    av_packet_free(&packet);
    return 0;
  }

  ReadResult read(emscripten::val read_function) {
    resolved_promise.await();

    read_data_function = read_function;

    write_vector.clear();
    subtitles.clear();

    bool finished = false;

    while (true) {
      if (packet != nullptr) {
        int process_ret = process_packet();
        if (process_ret == 3) {
          finished = true;
          break;
        }
        if (process_ret == 2) break;
        if (process_ret == 1) continue;
        packet = nullptr;
      }

      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        // if ret == AVERROR_EOF, we finalize
        if (ret == AVERROR_EOF) {
          // flush + trailer
          avio_flush(output_format_context->pb);
          av_write_trailer(output_format_context);
          av_packet_free(&packet);
          finished = true;
          break;
        }
        av_packet_free(&packet);
        break;
      }

      if (packet->stream_index >= number_of_streams
          || streams_list[packet->stream_index] < 0) {
        // not an included stream, drop
        av_packet_free(&packet);
        continue;
      }
      AVStream* in_stream  = input_format_context->streams[packet->stream_index];
      bool is_non_av = in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE;
      printf("is_non_av %d\n", is_non_av);

      bool is_keyframe = !is_non_av && (packet->flags & AV_PKT_FLAG_KEY) != 0;
      if (!has_seen_non_keyframe && !is_keyframe) {
        has_seen_non_keyframe = true;
      }
      printf("is_keyframe %d\n", is_keyframe);
      if (has_seen_non_keyframe && is_keyframe && has_outputed_first_keyframe) {
        break;
      }

      int process_ret = process_packet();
      if (process_ret == 3) {
        finished = true;
        break;
      }
      if (process_ret == 2) break;
      if (process_ret == 1) continue;
    }

    ReadResult result;
    result.data = write_vector;
    result.subtitles = subtitles;
    result.finished = finished;

    read_data_function = val::undefined();
    return result;
  }

  int seek(int timestamp) {
    if (output_format_context) {
      av_write_trailer(output_format_context);
      if (streams_list) {
        av_freep(&streams_list);
        streams_list = nullptr;
      }
      if (output_avio_context) {
        av_free(output_avio_context->buffer);
        avio_context_free(&output_avio_context);
        output_avio_context = nullptr;
      }
      avformat_free_context(output_format_context);
      output_format_context = nullptr;
    }

    prev_duration = 0;
    prev_pts = 0;
    prev_pos = 0;
    duration = 0;
    pts = 0;
    pos = 0;
    is_header = true;

    int ret = av_seek_frame(input_format_context, video_stream_index, timestamp, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
      printf("ERROR: av_seek_frame: %s\n", ffmpegErrStr(ret).c_str());
      return 1;
    }

    output_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    output_avio_context = avio_alloc_context(
      output_avio_buffer,
      buffer_size,
      1,
      this,
      nullptr,
      &Remuxer::avio_write,
      nullptr
    );

    avformat_alloc_output_context2(&output_format_context, NULL, "mp4", NULL);
    output_format_context->pb = output_avio_context;

    number_of_streams = input_format_context->nb_streams;
    streams_list = (int*)av_calloc(number_of_streams, sizeof(*streams_list));

    if (!streams_list) {
      printf("ERROR: could not allocate stream_list\n");
      return 1;
    }

    int out_index = 0;
    for (int i = 0; i < number_of_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      AVCodecParameters* in_codecpar = in_stream->codecpar;
      if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO ||
          in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        AVStream* out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          printf("ERROR: could not allocate out stream\n");
          return 1;
        }
        int cpRet = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
        if (cpRet < 0) {
          printf("ERROR: copy codec params %s\n", ffmpegErrStr(cpRet).c_str());
          return 1;
        }
        streams_list[i] = out_index++;
      } else {
        streams_list[i] = -1;
      }
    }

    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "c", "copy", 0);
    av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);
    ret = avformat_write_header(output_format_context, &opts);
    if (ret < 0) {
      printf("ERROR: writing header after seek: %s\n", ffmpegErrStr(ret).c_str());
      return 1;
    }

    return 0;
  }

  //-----------------------------------------
  // Cleanup everything
  //-----------------------------------------
  void destroy() {
    if (streams_list) {
      av_freep(&streams_list);
      streams_list = nullptr;
    }
    if (input_avio_context) {
      av_free(input_avio_context->buffer);
      input_avio_context->buffer = nullptr;
      avio_context_free(&input_avio_context);
      input_avio_context = nullptr;
    }
    if (input_format_context) {
      avformat_close_input(&input_format_context);
      input_format_context = nullptr;
    }
    if (output_avio_context) {
      av_free(output_avio_context->buffer);
      output_avio_context->buffer = nullptr;
      avio_context_free(&output_avio_context);
      output_avio_context = nullptr;
    }
    if (output_format_context) {
      avformat_free_context(output_format_context);
      output_format_context = nullptr;
    }
  }

private:
  static int avio_read(void* opaque, uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);
    std::string buffer;
    emscripten::val result = self->read_data_function(to_string(self->input_format_context->pb->pos), buf_size).await();

    bool is_rejected = result["rejected"].as<bool>();
    if (is_rejected) {
      return AVERROR_EXIT;
    }
    
    buffer = result["resolved"].as<std::string>();
    int buffer_size = buffer.size();
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }

    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);

    return buffer_size;
  }

  static int64_t avio_seek(void* opaque, int64_t offset, int whence) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    switch (whence) {
      case AVSEEK_SIZE:
        return self->input_length;
      case SEEK_SET:
        self->currentOffset = offset;
        return self->currentOffset;
      case SEEK_CUR:
        self->currentOffset = self->currentOffset + offset;
        return self->currentOffset;
      case SEEK_END:
        self->currentOffset = self->input_length - offset;
        return self->currentOffset;
      default:
        return -1;
    }
  }

  static int avio_write(void* opaque, uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    printf("avio_write %d\n", buf_size);

    if (self->has_seen_non_keyframe && !self->has_outputed_first_keyframe) {
      self->has_outputed_first_keyframe = true;
    }

    emscripten::val uint8_array = emscripten::val(
      emscripten::typed_memory_view(
        buf_size,
        buf
      )
    );

    self->write_vector.push_back(uint8_array);

    return buf_size;
  }
};

EMSCRIPTEN_BINDINGS(libav_wasm_simplified) {
  emscripten::register_vector<Attachment>("VectorAttachment");
  emscripten::register_vector<SubtitleFragment>("VectorSubtitleFragment");
  emscripten::register_vector<uint8_t>("VectorUInt8");
  emscripten::register_vector<emscripten::val>("VectorVal");

  emscripten::value_object<Attachment>("Attachment")
    .field("filename", &Attachment::filename)
    .field("mimetype", &Attachment::mimetype)
    .field("data",     &Attachment::data);

  emscripten::value_object<SubtitleFragment>("SubtitleFragment")
    .field("streamIndex", &SubtitleFragment::streamIndex)
    .field("isHeader",    &SubtitleFragment::isHeader)
    .field("data",        &SubtitleFragment::data)
    .field("language",    &SubtitleFragment::language)
    .field("title",       &SubtitleFragment::title)
    .field("start",       &SubtitleFragment::start)
    .field("end",         &SubtitleFragment::end);

  emscripten::value_object<MediaInfo>("MediaInfo")
    .field("formatName",      &MediaInfo::formatName)
    .field("mimeType",        &MediaInfo::mimeType)
    .field("duration",        &MediaInfo::duration)
    .field("videoMimeType",   &MediaInfo::video_mime_type)
    .field("audioMimeType",   &MediaInfo::audio_mime_type);

  emscripten::value_object<IOInfo>("IOInfo")
    .field("input",  &IOInfo::input)
    .field("output", &IOInfo::output);

  emscripten::value_object<InitResult>("InitResult")
    .field("data",        &InitResult::data)
    .field("attachments", &InitResult::attachments)
    .field("subtitles",   &InitResult::subtitles)
    .field("info",        &InitResult::info);

  emscripten::value_object<ReadResult>("ReadResult")
    .field("data",      &ReadResult::data)
    .field("subtitles", &ReadResult::subtitles)
    .field("finished",  &ReadResult::finished);

  emscripten::class_<Remuxer>("Remuxer")
    .constructor<emscripten::val>()
    .function("init",    &Remuxer::init)
    .function("read",    &Remuxer::read)
    .function("seek",    &Remuxer::seek)
    .function("destroy", &Remuxer::destroy);
}
