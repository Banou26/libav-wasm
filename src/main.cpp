#include <emscripten.h>
#include <emscripten/bind.h>
#include <vector>
#include <sstream>

using namespace emscripten;
using namespace std;

extern "C" {
  #include <libavformat/avio.h>
  #include <libavcodec/avcodec.h>
  #include <libavformat/avformat.h>
};

template <class T>
inline std::string to_string (const T& t)
{
    std::stringstream ss;
    ss << t;
    return ss.str();
}

int main() {
  return 0;
}

typedef struct MediaInfoObject {
  std::string formatName;
  std::string mimeType;
  double duration;
  std::string video_mime_type;
  std::string audio_mime_type;
} MediaInfoObject;

typedef struct InfoObject {
  MediaInfoObject input;
  MediaInfoObject output;
} InfoObject;

extern "C" {

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size);
  static int readFunction(void* opaque, uint8_t* buf, int buf_size);
  static int readOutputFunction(void* opaque, uint8_t* buf, int buf_size);
  static int64_t seekFunction(void* opaque, int64_t offset, int whence);

  class Remuxer {
  public:
    AVIOContext* input_avio_context;
    AVIOContext* output_avio_context;
    AVFormatContext* output_format_context;
    AVFormatContext* input_format_context;
    uint8_t* input_avio_buffer;
    uint8_t* output_avio_buffer;
    int stream_index;
    int *streams_list;
    int number_of_streams;
    float input_length;
    int buffer_size;
    int video_stream_index;

    bool is_header;
    bool is_flushing;
    long prev_pos;
    double prev_pts;
    double prev_duration;
    long pos;
    double pts;
    double duration;
    bool first_frame = true;
    bool cancelling = false;

    std::string video_mime_type;
    std::string audio_mime_type;

    val randomRead = val::undefined();

    val streamRead = val::undefined();
    val currentReadStream = val::undefined();
    val clearStream = val::undefined();

    val attachment = val::undefined();
    val subtitle = val::undefined();
    val write = val::undefined();
    val flush = val::undefined();
    val error = val::undefined();
    val exit = val::undefined();

    double currentOffset = 0;

    bool first_init = true;
    bool initializing = false;

    vector<std::string> init_buffers;
    int init_buffer_count = 0;

    bool first_seek = true;
    bool seeking = false;

    vector<std::string> seek_buffers;
    int seek_buffer_count = 0;

    val promise = val::undefined();
    // val promise = val::global("Promise")["resolve"]().as<val>();
    // val promise = val::global("Promise").get("resolve").as<val>();

    static void print_dict(const AVDictionary *m)
    {
        AVDictionaryEntry *t = nullptr;
        while ((t = av_dict_get(m, "", t, AV_DICT_IGNORE_SUFFIX)))
            printf("%s %s   ", t->key, t->value);
        printf("\n");
    }

    Remuxer(val options) {
      promise = options["promise"];
      input_length = options["length"].as<float>();
      buffer_size = options["bufferSize"].as<int>();
      randomRead = options["randomRead"];
      streamRead = options["streamRead"];
      clearStream = options["clearStream"];
      attachment = options["attachment"];
      subtitle = options["subtitle"];
      write = options["write"];
      flush = options["flush"];
      error = options["error"];
      exit = options["exit"];
    }

    auto decimalToHex(int d, int padding) {
      std::string hex = std::to_string(d);
      while (hex.length() < padding) {
        hex = "0" + hex;
      }
      return hex;
    }

    std::string parse_mp4a_mime_type(AVCodecParameters *in_codecpar) {
      // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/descriptor.js#L5
      switch (in_codecpar->profile) {
        case FF_PROFILE_AAC_LOW:
          return "mp4a.40.2"; // AAC-LC
        case FF_PROFILE_AAC_HE:
          return "mp4a.40.5"; // HE-AAC / AAC+ (SBR)
        case FF_PROFILE_AAC_HE_V2:
          return "mp4a.40.29"; // HE-AAC v2 / AAC++ (SBR+PS)
        case FF_PROFILE_AAC_LD:
          return "mp4a.40.23"; // AAC-LD
        case FF_PROFILE_AAC_ELD:
          return "mp4a.40.39"; // AAC-ELD
        case FF_PROFILE_UNKNOWN:
        default:
          return "mp4a.40.unknown";
      }
    }

    std::string parse_h264_mime_type(AVCodecParameters *in_codecpar) {
      auto extradata = in_codecpar->extradata;
      auto extradata_size = in_codecpar->extradata_size;
      char mime_type[50];

      if (!extradata || extradata_size < 1) {
        printf("Invalid extradata.\n");
        return mime_type;
      }

      if (extradata[0] != 1) {
        printf("Unsupported extradata format.\n");
        return mime_type;
      }

      // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/parsing/avcC.js#L6
      uint8_t profile = extradata[1];
      uint8_t constraints = extradata[2];
      uint8_t level = extradata[3];

      sprintf(mime_type, "avc1.%02x%02x%02x", profile, constraints, level);
      return mime_type;
    }

    std::string parse_h265_mime_type(AVCodecParameters *in_codecpar) {
      auto extradata = in_codecpar->extradata;
      auto extradata_size = in_codecpar->extradata_size;
      char mime_type[50];

      if (!extradata || extradata_size < 1) {
        printf("Invalid extradata.\n");
        return mime_type;
      }

      if (extradata[0] != 1) {
        printf("Unsupported extradata format.\n");
        return mime_type;
      }

      // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/parsing/hvcC.js
      // https://github.com/gpac/mp4box.js/blob/a8f4cd883b8221bedef1da8c6d5979c2ab9632a8/src/box-codecs.js#L106
      // https://github.com/paulhiggs/codec-string/blob/ab2e7869f1d9207b24cfd29031b79d7abf164a5e/src/decode-hevc.js
      uint8_t multi = extradata[1];
      uint8_t general_profile_space = multi >> 6;
      uint8_t general_tier_flag = (multi & 0x20) >> 5;
      uint8_t general_profile_idc = (multi & 0x1F);
      uint32_t general_profile_compatibility_flags = extradata[2] << 24 | extradata[3] << 16 | extradata[4] << 8 | extradata[5];
      uint8_t general_constraint_indicator_flags = extradata[6];
      uint8_t general_level_idc = extradata[12];

      auto general_profile_space_str =
        general_profile_space == 0 ? "" :
        general_profile_space == 1 ? "A" :
        general_profile_space == 2 ? "B" :
        "C";

      uint8_t reversed = 0;
      for (int i=0; i<32; i++) {
        reversed |= general_profile_compatibility_flags & 1;
        if (i==31) break;
        reversed <<= 1;
        general_profile_compatibility_flags >>=1;
      }
      uint8_t general_profile_compatibility_reversed = reversed;

      auto general_tier_flag_str =
        general_tier_flag == 0
          ? "L"
          : "H";

      sprintf(
        mime_type, "hev1.%s%d.%s.%s%d.%02x",
        general_profile_space_str,
        general_profile_idc,
        decimalToHex(general_profile_compatibility_reversed, 0).c_str(),
        general_tier_flag_str,
        general_level_idc,
        general_constraint_indicator_flags
      );
      return mime_type;
    }
    
    void init () {
      initializing = true;
      init_buffer_count = 0;
      seek_buffer_count = 0;
      int res;
      is_header = true;
      duration = 0;
      first_frame = true;

      prev_duration = 0;
      prev_pts = 0;
      prev_pos = 0;
      duration = 0;
      pts = 0;
      pos = 0;

      input_avio_context = nullptr;
      input_format_context = avformat_alloc_context();
      // output_format_context = avformat_alloc_context();

      stream_index = 0;
      streams_list = nullptr;
      number_of_streams = 0;

      // Initialize the input avio context
      input_avio_buffer = static_cast<uint8_t*>(av_malloc(buffer_size));
      input_avio_context = avio_alloc_context(
        input_avio_buffer,
        buffer_size,
        0,
        reinterpret_cast<void*>(this),
        &readFunction,
        nullptr,
        &seekFunction
      );

      input_format_context->pb = input_avio_context;

      // Open the input stream and automatically recognise format
      if ((res = avformat_open_input(&input_format_context, NULL, nullptr, nullptr)) < 0) {
        printf("ERROR: could not open format context input | %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }

      // Initialize the output avio context
      output_avio_buffer = static_cast<uint8_t*>(av_malloc(buffer_size));
      output_avio_context = avio_alloc_context(
        output_avio_buffer,
        buffer_size,
        1,
        reinterpret_cast<void*>(this),
        nullptr,
        &writeFunction,
        nullptr
      );

      // Initialize the output format stream context as an mp4 file
      avformat_alloc_output_context2(&output_format_context, NULL, "mp4", NULL);
      // Set the avio context to the output format context
      output_format_context->pb = output_avio_context;
      // output_format_context->flags |= AVFMT_FLAG_CUSTOM_IO;

      number_of_streams = input_format_context->nb_streams;
      streams_list = (int *)av_calloc(number_of_streams, sizeof(*streams_list));

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        printf("ERROR: could not allocate a stream list | %s \n", av_err2str(res));
        return;
      }

      // Loop through all of the input streams
      for (int i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVStream *out_in_stream;
        AVCodecParameters *in_codecpar = in_stream->codecpar;

        // Filter out all non video/audio/subtitles/attachments streams
        if (
          in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE &&
          in_codecpar->codec_type != AVMEDIA_TYPE_ATTACHMENT
        ) {
          streams_list[i] = -1;
          continue;
        }

        // call the JS attachment callback and continue to next stream
        if (in_codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
          if (!first_init) continue;
          // Get attachment codec context
          // AVCodec*
          auto codec = avcodec_find_decoder(in_codecpar->codec_id);
          AVCodecContext* codecCtx = avcodec_alloc_context3(codec);
          avcodec_parameters_to_context(codecCtx, in_codecpar);
          // Get filename and mimetype of the attachment
          AVDictionaryEntry* filename_entry = av_dict_get(in_stream->metadata, "filename", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string filename = std::string(filename_entry->value);
          AVDictionaryEntry* mimetype_entry = av_dict_get(in_stream->metadata, "mimetype", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string mimetype = std::string(mimetype_entry->value);
          // call the js attachment callback
          attachment(
            filename,
            mimetype,
            emscripten::val(
              emscripten::typed_memory_view(
                codecCtx->extradata_size,
                codecCtx->extradata
              )
            )
          );
          // cleanup
          avcodec_free_context(&codecCtx);
          continue;
        }

        // call the JS subtitle callback and continue to next stream
        if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          if (!first_init) continue;
          // Get subtitle codec context
          // AVCodec*
          auto codec = avcodec_find_decoder(in_codecpar->codec_id);
          AVCodecContext* codecCtx = avcodec_alloc_context3(codec);
          avcodec_parameters_to_context(codecCtx, in_codecpar);
          // allocate space for the subtitle extradata(header)
          codecCtx->subtitle_header = static_cast<uint8_t*>(av_malloc(codecCtx->extradata_size + 1));
          if (!codecCtx->subtitle_header) {
            res = AVERROR(ENOMEM);
            printf("ERROR: could not allocate subtitle headers | %s \n", av_err2str(res));
            continue;
          }
          /**
           * Copy the contents of the subtitle header manually,
           * as its format is pretty simple and we don't want
           * to include the actual heavy subtitle decoder
           */
          if (codecCtx->extradata_size) {
            memcpy(codecCtx->subtitle_header, codecCtx->extradata, codecCtx->extradata_size);
          }
          codecCtx->subtitle_header[codecCtx->extradata_size] = 0;
          codecCtx->subtitle_header_size = codecCtx->extradata_size;
          // Get language and title of the subtitle
          AVDictionaryEntry* language_entry = av_dict_get(in_stream->metadata, "language", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string language = std::string(language_entry->value);
          AVDictionaryEntry* title_entry = av_dict_get(in_stream->metadata, "title", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string title = std::string(title_entry->value);
          std::string data = reinterpret_cast<char*>(codecCtx->subtitle_header);
          // call the js subtitle callback
          subtitle(
            i,
            true,
            data,
            language,
            title
          );
          // cleanup
          av_free(codecCtx->subtitle_header);
          codecCtx->subtitle_header = NULL;
          avcodec_free_context(&codecCtx);
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          video_stream_index = i;
          if (first_init) {
            std::string mime_type;
            if (in_codecpar->codec_id == AV_CODEC_ID_H264) {
              mime_type = parse_h264_mime_type(in_codecpar).c_str();
            } else  if (in_codecpar->codec_id == AV_CODEC_ID_H265) {
              mime_type = parse_h265_mime_type(in_codecpar).c_str();
            } 
            video_mime_type = mime_type;
          }
        }
        if (first_init && in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO){
          std::string mime_type;
          if (in_codecpar->codec_id == AV_CODEC_ID_AAC) {
            mime_type = parse_mp4a_mime_type(in_codecpar).c_str();
          }
          audio_mime_type = mime_type;
        }

        streams_list[i] = stream_index++;
        // Open a new output stream
        out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          res = AVERROR_UNKNOWN;
          printf("ERROR: could not allocate output stream | %s \n", av_err2str(res));
          return;
        }
        // Copy all of the input file codecs to the output file codecs
        if ((res = avcodec_parameters_copy(out_stream->codecpar, in_codecpar)) < 0) {
          printf("ERROR: could not copy codec parameters | %s \n", av_err2str(res));
          return;
        }
      }

      AVDictionary* opts = nullptr;
      // Force transmuxing instead of re-encoding by copying the codecs
      av_dict_set(&opts, "c", "copy", 0);
      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      // Fragment the MP4 output
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

      // Writes the header of the output
      if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
        printf("ERROR: could not write output header | %s \n", av_err2str(res));
        return;
      }
      if (first_init) {
        flush(
          to_string(input_format_context->pb->pos),
          to_string(0),
          0,
          0
        );
        is_flushing = false;
      }

      initializing = false;
      first_init = false;
    }

    void read() {
      int res;

      bool flushed = false;
      // loop through the packet frames until we reach the processed size
      while (!flushed) {
        AVPacket* packet = av_packet_alloc();

        if ((res = av_read_frame(input_format_context, packet)) < 0) {
          if (res == AVERROR_EOF) {
            avio_flush(output_format_context->pb);
            is_flushing = true;
            av_write_trailer(output_format_context);
            flush(
              to_string(input_format_context->pb->pos),
              to_string(pos),
              pts,
              duration
            );
            // destroy();
            break;
          } else if (res == AVERROR_EXIT) {
            cancelling = false;
            printf("ERROR: could not read frame, exit requested | %s \n", av_err2str(res));
            exit();
            break;
          }
          printf("ERROR: could not read frame | %s \n", av_err2str(res));
          break;
        }

        AVStream* in_stream = input_format_context->streams[packet->stream_index];
        AVStream* out_stream = output_format_context->streams[packet->stream_index];

        if (packet->stream_index >= number_of_streams || streams_list[packet->stream_index] < 0) {
          // free packet as it's not in a used stream and continue to next packet
          av_packet_unref(packet);
          av_packet_free(&packet);
          continue;
        }

        // Read subtitle packet and call JS subtitle callback
        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          long start = packet->pts;
          long end = start + packet->duration;
          std::string data = reinterpret_cast<char *>(packet->data);
          // call JS subtitle callback
          subtitle(
            packet->stream_index,
            false,
            data,
            start,
            end
          );
          av_packet_unref(packet);
          av_packet_free(&packet);
          continue;
        }

        // Read audio packet and write it to the output context
        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
          av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
          if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
            printf("ERROR: could not write interleaved frame | %s \n", av_err2str(res));
          }
          av_packet_unref(packet);
          av_packet_free(&packet);
          continue;
        }

        bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

        // Rescale the PTS/DTS from the input time base to the output time base
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          // printf("pts: %f, prev duration: %f, duration: %f\n", packet->pts * av_q2d(out_stream->time_base), duration, packet->duration * av_q2d(out_stream->time_base));
          duration += packet->duration * av_q2d(out_stream->time_base);
        }

        bool empty_flush = false;

        // Set needed pts/pos/duration needed to calculate the real timestamps
        if (is_keyframe) {
          bool was_header = is_header;
          if (was_header) {
            is_header = false;
          } else {
            is_flushing = true;
            empty_flush = flush(
              to_string(input_format_context->pb->pos),
              to_string(prev_pos),
              prev_pts,
              prev_duration
            ).await().as<bool>();
            flushed = true;
          }

          prev_duration = duration;
          prev_pts = pts;
          // printf("pts: %f, duration: %f\n", prev_pts, duration);
          prev_pos = pos;

          duration = 0;

          pts = packet->pts * av_q2d(out_stream->time_base);
          pos = packet->pos;
        }

        // Write the frames to the output context
        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          printf("ERROR: could not write interleaved frame | %s \n", av_err2str(res));
          continue;
        }

        if (is_flushing && empty_flush) {
          empty_flush = flush(
            to_string(input_format_context->pb->pos),
            to_string(prev_pos),
            prev_pts,
            prev_duration
          ).await().as<bool>();
          is_flushing = false;
          flushed = true;

          if (empty_flush) {
            flushed = false;
          }
        }

        // free packet
        av_packet_unref(packet);
        av_packet_free(&packet);
      }
    }

    InfoObject getInfo () {
      return {
        .input = {
          .formatName = input_format_context->iformat->name,
          .mimeType = input_format_context->iformat->mime_type,
          .duration = static_cast<double>(input_format_context->duration),
          .video_mime_type = video_mime_type,
          .audio_mime_type = audio_mime_type
        },
        .output = {
          .formatName = output_format_context->oformat->name,
          .mimeType = output_format_context->oformat->mime_type,
          .duration = static_cast<double>(output_format_context->duration),
          .video_mime_type = video_mime_type,
          .audio_mime_type = audio_mime_type
        }
      };
    }

    int64_t getInputPosition () {
      return input_avio_context->pos;
    }

    int64_t getOutputPosition () {
      return output_avio_context->pos;
    }

    int _seek(int timestamp) {
      seeking = true;
      destroy();
      init();

      clearStream().await();

      int res;
      prev_duration = 0;
      prev_pts = 0;
      prev_pos = 0;
      duration = 0;
      pts = 0;
      pos = 0;
      if ((res = av_seek_frame(input_format_context, video_stream_index, timestamp, AVSEEK_FLAG_BACKWARD)) < 0) {
        seeking = false;
        first_seek = false;
        printf("ERROR: could not seek frame | %s \n", av_err2str(res));
        return 1;
      }
      seeking = false;
      first_seek = false;
      return 0;
    }

    void destroy () {
      // check if we need to write trailer at some point
      // av_write_trailer(output_format_context);

      av_freep(streams_list);
      streams_list = nullptr;

      // We have to free like this, as reported by https://fftrac-bg.ffmpeg.org/ticket/1357
      av_free(input_avio_context->buffer);
      input_avio_buffer = nullptr;
      avio_context_free(&input_avio_context);
      input_avio_context = nullptr;
      avformat_close_input(&input_format_context);
      input_format_context = nullptr;

      av_free(output_avio_context->buffer);
      avio_context_free(&output_avio_context);
      output_avio_context = nullptr;
      avformat_free_context(output_format_context);
      output_format_context = nullptr;
    }
  };

  // Seek callback called by AVIOContext
  static int64_t seekFunction(void* opaque, int64_t offset, int whence) {
    Remuxer &remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    if (whence == SEEK_CUR) {
      return remuxObject.currentOffset + offset;
    }
    if (whence == SEEK_END) {
      return -1;
    }
    if (whence == SEEK_SET) {
      return offset;
    }
    if (whence == AVSEEK_SIZE) {
      return remuxObject.input_length;
    }
    return -1;
  }

  // If emscripten asynchify ever start working for libraries callbacks,
  // replace the blocking write function with an async callback

  // Read callback called by AVIOContext
  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    Remuxer &remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    std::string buffer;

    if (remuxObject.cancelling) {
      remuxObject.promise.await();
      return AVERROR_EXIT;
    }

    if (remuxObject.initializing) {
      emscripten::val &randomRead = remuxObject.randomRead;
      if (remuxObject.first_init) {
        printf("c++ read started init\n");
        emscripten::val result =
          randomRead(
            to_string(remuxObject.input_format_context->pb->pos),
            buf_size
          )
            .await();
        printf("c++ read init done\n");
        bool is_cancelled = result["cancelled"].as<bool>();
        if (is_cancelled) {
          return AVERROR_EXIT;
        }
        bool is_done = result["done"].as<bool>();
        if (is_done) {
          return AVERROR_EOF;
        }
        buffer = result["buffer"].as<std::string>();
        remuxObject.init_buffers.push_back(buffer);
      } else {
        remuxObject.promise.await();
        buffer = remuxObject.init_buffers[remuxObject.init_buffer_count];
        remuxObject.init_buffer_count++;
      }
    } else if(remuxObject.seeking) {
      emscripten::val &randomRead = remuxObject.randomRead;
      if (remuxObject.first_seek) {
        printf("c++ read seeking started\n");
        emscripten::val result =
          randomRead(
            to_string(remuxObject.input_format_context->pb->pos),
            buf_size
          )
            .await();
        printf("c++ read seeking done\n");
        bool is_cancelled = result["cancelled"].as<bool>();
        remuxObject.cancelling = is_cancelled;
        if (is_cancelled) {
          return AVERROR_EXIT;
        }
        bool is_done = result["done"].as<bool>();
        if (is_done) {
          return AVERROR_EOF;
        }
        buffer = result["buffer"].as<std::string>();
        remuxObject.seek_buffers.push_back(buffer);
      } else {
        remuxObject.promise.await();
        buffer = remuxObject.seek_buffers[remuxObject.seek_buffer_count];
        remuxObject.seek_buffer_count++;
      }
    } else {
      printf("c++ read normal started\n");
      emscripten::val result =
        remuxObject
          .streamRead(
            to_string(remuxObject.input_format_context->pb->pos),
            buf_size
          )
          .await();
      printf("c++ read normal done\n");
      bool is_cancelled = result["cancelled"].as<bool>();
      if (is_cancelled) {
        return AVERROR_EXIT;
      }
      bool is_done = result["done"].as<bool>();
      if (is_done) {
        return AVERROR_EOF;
      }
      buffer = result["buffer"].as<std::string>();
    }

    int buffer_size = buffer.size();
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }
    // copy the result buffer into AVIO's buffer
    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);

    remuxObject.currentOffset = remuxObject.currentOffset + buffer_size;
    // If result buffer size is 0, we reached the end of the file
    return buffer_size;
  }

  // Write callback called by AVIOContext
  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    Remuxer &remuxObject = *reinterpret_cast<Remuxer*>(opaque);

    if (remuxObject.initializing && !remuxObject.first_init) {
      return buf_size;
    }

    emscripten::val &write = remuxObject.write;
    // call the JS write function

    write(
      emscripten::val(
        emscripten::typed_memory_view(
          buf_size,
          buf
        )
      )
    );

    return buf_size;
  }

  // Binding code
  EMSCRIPTEN_BINDINGS(libav_wasm) {

    emscripten::value_object<MediaInfoObject>("MediaInfoObject")
      .field("formatName", &MediaInfoObject::formatName)
      .field("duration", &MediaInfoObject::duration)
      .field("mimeType", &MediaInfoObject::mimeType)
      .field("video_mime_type", &MediaInfoObject::video_mime_type)
      .field("audio_mime_type", &MediaInfoObject::audio_mime_type);

    emscripten::value_object<InfoObject>("InfoObject")
      .field("input", &InfoObject::input)
      .field("output", &InfoObject::output);

    class_<Remuxer>("Remuxer")
      .constructor<emscripten::val>()
      .function("init", &Remuxer::init)
      .function("read", &Remuxer::read)
      .function("destroy", &Remuxer::destroy)
      .function("seek", &Remuxer::_seek)
      .function("getInfo", &Remuxer::getInfo);
  }
}
