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
  #include <libswscale/swscale.h>
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
  size_t size;
  size_t ptr;
} Attachment;

typedef struct SubtitleFragment {
  int streamIndex;
  bool isHeader;
  std::string data;
  std::string language;
  std::string title;
  long start;
  long end;
} SubtitleFragment;

typedef struct Index {
  int index;
  float timestamp;
  size_t pos;
} Index;

typedef struct Chapter {
  int index;
  float start;
  float end;
  std::string title;
} Chapter;

typedef struct InitResult {
  emscripten::val data;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;
  IOInfo info;
  std::vector<uint8_t> attachments_data;
  std::vector<Index> indexes;
  std::vector<Chapter> chapters;
} InitResult;

typedef struct ReadResult {
  emscripten::val data;
  std::vector<SubtitleFragment> subtitles;
  long offset;
  double pts;
  double duration;
  bool cancelled;
  bool finished;
} ReadResult;

typedef struct ThumbnailResult {
  emscripten::val data;
  int width;
  int height;
  bool cancelled;
} ThumbnailResult;

// typedef struct SeekResult {
//   emscripten::val data;
//   std::vector<SubtitleFragment> subtitles;
//   long offset;
//   double pts;
//   double duration;
// }

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
  double prev_duration = 0;
  double prev_pts = 0;
  long   prev_pos = 0;
  double duration = 0;
  double pts = 0;
  long   pos = 0;

  // Some track-level info for building correct mime types
  std::string video_mime_type;
  std::string audio_mime_type;

  bool initializing = false;
  bool first_initialization_done = false;
  int init_buffer_count = 0;
  std::vector<std::string> init_vector;
  std::vector<uint8_t> write_vector;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;

  emscripten::val resolved_promise = val::undefined();
  emscripten::val read_data_function = val::undefined();

  AVPacket* packet = nullptr;
  bool wrote = false;

  Remuxer(emscripten::val options) {
    resolved_promise = options["resolvedPromise"];
    input_length = options["length"].as<float>();
    buffer_size = options["bufferSize"].as<int>();
  }

  ~Remuxer() {
    destroy();
  }

  auto decimalToHex(int d, int padding) {
    std::string hex = std::to_string(d);
    while (hex.length() < padding) {
      hex = "0" + hex;
    }
    return hex;
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

  void init_input(bool skip = false) {
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

    if (skip) {
      AVDictionary* opts = nullptr;
      av_dict_set(&opts, "analyzeduration", "1", 0);
      // av_dict_set(&opts, "probesize", "1310720", 0);
      int ret = avformat_open_input(&input_format_context, NULL, nullptr, &opts);
      // int ret = avformat_open_input(&input_format_context, NULL, nullptr, nullptr);
      if (ret < 0) {
        throw std::runtime_error(
          "Could not open input: " + ffmpegErrStr(ret)
        );
      }
    } else {
      int ret = avformat_open_input(&input_format_context, NULL, nullptr, nullptr);
      if (ret < 0) {
        throw std::runtime_error(
          "Could not open input: " + ffmpegErrStr(ret)
        );
      }
    }
  }

  void destroy_input() {
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
  }

  void init_output() {
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
  }

  void destroy_output() {
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

  void init_streams(bool skip = false) {
    if (skip) {
      int ret = avformat_find_stream_info(input_format_context, nullptr);
      if (ret < 0) {
        throw std::runtime_error(
          "Could not find stream info: " + ffmpegErrStr(ret)
        );
      }
      for (int i = 0; i < number_of_streams; i++) {
        AVStream* in_stream = input_format_context->streams[i];
        AVCodecParameters* in_codecpar = in_stream->codecpar;
        if (!(
          in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO ||
          in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO
        )) {
          continue;
        }
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
      }
      return;
    }

    int ret = avformat_find_stream_info(input_format_context, nullptr);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not find stream info: " + ffmpegErrStr(ret)
      );
    }

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
        Attachment attachment;
    
        // Copy metadata
        if (auto fn = av_dict_get(in_stream->metadata, "filename", NULL, 0)) {
          attachment.filename = fn->value;
        }
        if (auto mt = av_dict_get(in_stream->metadata, "mimetype", NULL, 0)) {
          attachment.mimetype = mt->value;
        }

        attachment.size = in_codecpar->extradata_size;
        attachment.ptr = (size_t)malloc(attachment.size);
        std::memcpy((void*)attachment.ptr, in_codecpar->extradata, attachment.size);

        attachments.push_back(attachment);
        streams_list[i] = -1;
        continue;
      }

      // We handle subtitles separately
      if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        // It's a subtitle header
        SubtitleFragment subtitle_fragment = SubtitleFragment();
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
        std::string subtitle_data;
        subtitle_data.assign((char*)in_codecpar->extradata, in_codecpar->extradata_size);
        subtitle_fragment.data = subtitle_data;

        subtitles.push_back(subtitle_fragment);
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
  }

  void destroy_streams() {
    if (streams_list) {
      av_freep(&streams_list);
      streams_list = nullptr;
    }
  }

  void write_header() {
    // Step E: set fragmentation flags
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "strict", "experimental", 0);
    av_dict_set(&opts, "c", "copy", 0);
    av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

    // Step F: write the MP4 header (this triggers avio_write => data -> data)
    int ret = avformat_write_header(output_format_context, &opts);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not write header: " + ffmpegErrStr(ret)
      );
    }
  }

  void reset_fragment() {
    prev_duration = 0;
    prev_pts = 0;
    prev_pos = 0;
    duration = 0;
    pts = 0;
    pos = 0;
  }

  void clear_attachments() {
    for (auto& attachment : attachments) {
      if (attachment.ptr) {
        free((void*)attachment.ptr);
        attachment.ptr = 0;
      }
    }
    attachments.clear();
  }

  ThumbnailResult extractThumbnail(emscripten::val read_function, double timestamp, int maxWidth, int maxHeight) {
    resolved_promise.await();
    
    read_data_function = read_function;
    
    printf("inited\n");
    
    // // Find decoder for video stream
    AVStream* video_stream = input_format_context->streams[video_stream_index];
    const AVCodec* decoder = avcodec_find_decoder(video_stream->codecpar->codec_id);
    if (!decoder) {
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }
    
    // Allocate and initialize decoder context
    AVCodecContext* decoder_ctx = avcodec_alloc_context3(decoder);
    if (!decoder_ctx) {
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }
    
    // Copy parameters from stream to decoder context
    if (avcodec_parameters_to_context(decoder_ctx, video_stream->codecpar) < 0) {
      avcodec_free_context(&decoder_ctx);
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }
    
    // Open decoder
    if (avcodec_open2(decoder_ctx, decoder, NULL) < 0) {
      avcodec_free_context(&decoder_ctx);
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }

    // Convert timestamp to stream time base
    int64_t seek_target = av_rescale_q(
      timestamp * AV_TIME_BASE, 
      AV_TIME_BASE_Q, 
      video_stream->time_base
    );

    printf("init context created\n");

    
    // Seek to timestamp
    if (av_seek_frame(input_format_context, video_stream_index, seek_target, AVSEEK_FLAG_BACKWARD) < 0) {
      avcodec_free_context(&decoder_ctx);
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }
    
    printf("init seeked\n");

    // Allocate packet and frame
    AVPacket* packet = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    
    bool frameFound = false;
    int64_t bestDiff = INT64_MAX;
    
    // Read frames until we find one close to the requested timestamp
    while (av_read_frame(input_format_context, packet) >= 0) {
      if (packet->stream_index == video_stream_index) {
        printf("init reading frame\n");
        int ret = avcodec_send_packet(decoder_ctx, packet);
        printf("init send packet\n");
        if (ret < 0) {
          break;
        }
        ret = avcodec_receive_frame(decoder_ctx, frame);
        frameFound = true;
        break;
      }
      av_packet_unref(packet);
    }
    printf("init read\n");
    
    // If no frame was found, send null packet to flush decoder
    if (!frameFound) {
      avcodec_send_packet(decoder_ctx, NULL);
      if (avcodec_receive_frame(decoder_ctx, frame) >= 0) {
        frameFound = true;
      }
    }
    
    // If no frame was found, return empty result
    if (!frameFound) {
      cleanup:
      av_frame_free(&frame);
      av_packet_free(&packet);
      avcodec_free_context(&decoder_ctx);
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }
    
    // Setup scaling context to convert frame to RGB
    AVFrame* rgb_frame = av_frame_alloc();
    
    // Calculate output dimensions while maintaining aspect ratio
    int output_width = frame->width;
    int output_height = frame->height;
    
    if (maxWidth > 0 && maxHeight > 0) {
      double aspectRatio = (double)frame->width / frame->height;
      if (output_width > maxWidth) {
        output_width = maxWidth;
        output_height = output_width / aspectRatio;
      }
      if (output_height > maxHeight) {
        output_height = maxHeight;
        output_width = output_height * aspectRatio;
      }
    }
    
    // Ensure even dimensions (required by some pixel formats)
    output_width = (output_width >> 1) << 1;
    output_height = (output_height >> 1) << 1;
    
    rgb_frame->format = AV_PIX_FMT_RGB24;
    rgb_frame->width = output_width;
    rgb_frame->height = output_height;
    av_frame_get_buffer(rgb_frame, 0);

    printf("init prep write\n");

    
    // Initialize SwsContext for scaling
    struct SwsContext* sws_ctx = sws_getContext(
      frame->width, frame->height, (AVPixelFormat)frame->format,
      output_width, output_height, AV_PIX_FMT_RGB24,
      SWS_BILINEAR, NULL, NULL, NULL
    );
    
    if (!sws_ctx) {
      av_frame_free(&rgb_frame);
      av_frame_free(&frame);
      av_packet_free(&packet);
      avcodec_free_context(&decoder_ctx);
      ThumbnailResult result;
      result.cancelled = true;
      return result;
    }
    
    // Convert frame to RGB
    sws_scale(sws_ctx, frame->data, frame->linesize, 0, frame->height,
              rgb_frame->data, rgb_frame->linesize);
    
    // Create a vector to hold the RGB data
    std::vector<uint8_t> rgb_data;
    rgb_data.reserve(output_width * output_height * 3);
    
    printf("init prep writing data\n");
    // Copy RGB data to vector
    for (int y = 0; y < output_height; y++) {
      rgb_data.insert(rgb_data.end(), 
                      rgb_frame->data[0] + y * rgb_frame->linesize[0],
                      rgb_frame->data[0] + y * rgb_frame->linesize[0] + output_width * 3);
    }

    printf("init prep wrote\n");

    
    // Clean up
    sws_freeContext(sws_ctx);
    av_frame_free(&rgb_frame);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&decoder_ctx);

    // Create result
    ThumbnailResult result;
    emscripten::val js_rgb_data = emscripten::val(
      emscripten::typed_memory_view(
        rgb_data.size(),
        rgb_data.data()
      )
    );
    result.data = js_rgb_data;
    result.width = output_width;
    result.height = output_height;
    result.cancelled = false;

    read_data_function = val::undefined();
    printf("init prep done\n");

    return result;
  }

  InitResult init(emscripten::val read_function) {
    read_data_function = read_function;

    reset_fragment();
    write_vector.clear();
    clear_attachments();
    subtitles.clear();
    video_mime_type.clear();
    audio_mime_type.clear();

    initializing = true;
    init_input();
    init_output();
    init_streams();
    write_header();
    initializing = false;
    first_initialization_done = true;

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
    emscripten::val js_write_vector = emscripten::val(
      emscripten::typed_memory_view(
        write_vector.size(),
        write_vector.data()
      )
    );

    result.data = js_write_vector;
    result.attachments = attachments;
    result.subtitles = subtitles;
    result.info = infoObj;

    // loop through the chapters
    for (int i = 0; i < input_format_context->nb_chapters; i++) {
      AVChapter *av_chapter = input_format_context->chapters[i];
      int64_t start_time = av_chapter->start * av_chapter->time_base.num / av_chapter->time_base.den;
      int64_t end_time = av_chapter->end * av_chapter->time_base.num / av_chapter->time_base.den;
      Chapter chapter;
      chapter.index = i;
      chapter.start = start_time;
      chapter.end = end_time;
      AVDictionaryEntry *capter_entry = NULL;
      capter_entry = av_dict_get(av_chapter->metadata, "title", NULL, 0);
      if (capter_entry) {
        chapter.title = capter_entry->value;
      }
      result.chapters.push_back(chapter);
    }

    // this is needed to load the seeking cues / indexes
    int ret = av_seek_frame(input_format_context, video_stream_index, 0, AVSEEK_FLAG_BACKWARD);

    AVStream* in_stream = input_format_context->streams[video_stream_index];
    int nb_entries = avformat_index_get_entries_count(in_stream);
    for (int i = 0; i < nb_entries; i++) {
      const AVIndexEntry* entry = avformat_index_get_entry(in_stream, i);
      if (entry->flags & AVINDEX_KEYFRAME) {
        Index index;
        index.index = i;
        index.pos = entry->pos;
        index.timestamp = entry->timestamp * av_q2d(in_stream->time_base);
        result.indexes.push_back(index);
      }
    }

    read_data_function = val::undefined();
    wrote = false;

    return result;
  }

  ReadResult read(emscripten::val read_function) {
    resolved_promise.await();

    read_data_function = read_function;

    write_vector.clear();
    subtitles.clear();

    bool finished = false;

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      // printf("READ FRAME read error | %s \n", av_err2str(ret));
      if (ret < 0) {
        // read_data_function = val::undefined();
        if (ret == AVERROR_EXIT) {
          ReadResult cancelled_result;
          cancelled_result.cancelled = true;
          read_data_function = val::undefined();
          return cancelled_result;
        }
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

      AVStream* in_stream  = input_format_context->streams[packet->stream_index];

      // If it's a subtitle packet
      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        SubtitleFragment subtitle_fragment;
        subtitle_fragment.streamIndex = packet->stream_index;
        subtitle_fragment.isHeader = false;
        subtitle_fragment.start = packet->pts;
        subtitle_fragment.end   = subtitle_fragment.start + packet->duration;
        // The actual subtitle data
        std::string subtitle_data;
        subtitle_data.assign((char*)packet->data, packet->size);
        subtitle_fragment.data = subtitle_data;

        subtitles.push_back(subtitle_fragment);
        continue;
      }

      if (packet->stream_index >= number_of_streams
          || streams_list[packet->stream_index] < 0) {
        // not an included stream, drop
        av_packet_free(&packet);
        continue;
      }

      if (packet->stream_index >= number_of_streams
          || streams_list[packet->stream_index] < 0) {
        // not an included stream, drop
        continue;
      }

      // If it's audio or video, we remux
      AVStream* out_stream = output_format_context->streams[streams_list[packet->stream_index]];

      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
        if ((ret = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          printf("ERROR: could not write interleaved frame | %s \n", av_err2str(ret));
        }
        av_packet_unref(packet);
        av_packet_free(&packet);
        continue;
      }

      bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

      duration += packet->duration * av_q2d(in_stream->time_base);
      // rescale timestamps
      av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

      if (is_keyframe) {
        prev_duration = duration;
        prev_pts = pts;
        prev_pos = pos;

        duration = 0;

        pts = packet->pts * av_q2d(out_stream->time_base);
        pos = packet->pos;
      }

      // Write to output
      ret = av_interleaved_write_frame(output_format_context, packet);
      if (ret < 0) {
        printf("Error writing frame: %s\n", ffmpegErrStr(ret).c_str());
        break;
      }

      av_packet_free(&packet);

      if (wrote) {
        wrote = false;
        break;
      }
    }

    ReadResult result;
    emscripten::val js_write_vector = emscripten::val(
      emscripten::typed_memory_view(
        write_vector.size(),
        write_vector.data()
      )
    );
    result.data = js_write_vector;
    result.subtitles = subtitles;
    result.offset = prev_pos;
    result.pts = prev_pts;
    result.duration = prev_duration;
    result.cancelled = false;
    result.finished = finished;

    read_data_function = val::undefined();
    return result;
  }

  ReadResult seek(emscripten::val read_function, int timestamp) {
    resolved_promise.await();

    read_data_function = read_function;

    // destroy_streams();
    destroy_input();
    destroy_output();

    av_packet_free(&packet);

    reset_fragment();
    write_vector.clear();
    clear_attachments();
    subtitles.clear();
    // video_mime_type.clear();
    // audio_mime_type.clear();

    initializing = true;
    init_input(true);
    init_output();
    init_streams(true);
    write_header();
    initializing = false;
    write_vector.clear();
    subtitles.clear();
    wrote = false;

    int ret = av_seek_frame(input_format_context, video_stream_index, timestamp, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
      printf("ERROR: av_seek_frame: %s\n", ffmpegErrStr(ret).c_str());
      ReadResult cancelled_result;
      cancelled_result.cancelled = true;
      read_data_function = val::undefined();
      return cancelled_result;
    }

    read_data_function = val::undefined();
    ReadResult read_result = read(read_function);
    return read_result;
  }

  //-----------------------------------------
  // Cleanup everything
  //-----------------------------------------
  void destroy() {
    destroy_streams();
    destroy_input();
    destroy_output();
  }

private:
  static int avio_read(void* opaque, uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    if (self->initializing && self->first_initialization_done) {
      std::string buffer = self->init_vector[self->init_buffer_count];
      memcpy(buf, (uint8_t*)buffer.c_str(), buf_size);
      self->init_buffer_count++;
      if (self->init_buffer_count >= self->init_vector.size()) {
        self->init_buffer_count = 0;
      }
      return buf_size;
    }

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

    if (self->initializing && !self->first_initialization_done) {
      self->init_vector.push_back(buffer);
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

    self->wrote = true;
    std::vector<uint8_t> chunk(buf, buf + buf_size);
    memcpy(chunk.data(), buf, buf_size);
    self->write_vector.insert(self->write_vector.end(), chunk.begin(), chunk.end());

    return buf_size;
  }
};

EMSCRIPTEN_BINDINGS(libav_wasm_simplified) {
  emscripten::register_vector<Attachment>("VectorAttachment");
  emscripten::register_vector<SubtitleFragment>("VectorSubtitleFragment");
  emscripten::register_vector<Index>("VectorIndex");
  emscripten::register_vector<Chapter>("VectorChapter");
  emscripten::register_vector<uint8_t>("VectorUInt8");
  emscripten::register_vector<emscripten::val>("VectorVal");

  emscripten::value_object<Attachment>("Attachment")
    .field("filename", &Attachment::filename)
    .field("mimetype", &Attachment::mimetype)
    .field("ptr",      &Attachment::ptr)
    .field("size",     &Attachment::size);

  emscripten::value_object<SubtitleFragment>("SubtitleFragment")
    .field("streamIndex", &SubtitleFragment::streamIndex)
    .field("isHeader",    &SubtitleFragment::isHeader)
    .field("data",        &SubtitleFragment::data)
    .field("language",    &SubtitleFragment::language)
    .field("title",       &SubtitleFragment::title)
    .field("start",       &SubtitleFragment::start)
    .field("end",         &SubtitleFragment::end);

  emscripten::value_object<Chapter>("Chapter")
    .field("index",  &Chapter::index)
    .field("start",  &Chapter::start)
    .field("end",    &Chapter::end)
    .field("title",  &Chapter::title);

  emscripten::value_object<Index>("Index")
    .field("index",  &Index::index)
    .field("timestamp",  &Index::timestamp)
    .field("pos",    &Index::pos);

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
    .field("chapters",    &InitResult::chapters)
    .field("indexes",     &InitResult::indexes)
    .field("info",        &InitResult::info);

  emscripten::value_object<ReadResult>("ReadResult")
    .field("data",      &ReadResult::data)
    .field("subtitles", &ReadResult::subtitles)
    .field("offset",    &ReadResult::offset)
    .field("pts",       &ReadResult::pts)
    .field("duration",  &ReadResult::duration)
    .field("cancelled", &ReadResult::cancelled)
    .field("finished",  &ReadResult::finished);

  emscripten::value_object<ThumbnailResult>("ThumbnailResult")
    .field("data",      &ThumbnailResult::data)
    .field("width",     &ThumbnailResult::width)
    .field("height",    &ThumbnailResult::height)
    .field("cancelled", &ThumbnailResult::cancelled);

  emscripten::class_<Remuxer>("Remuxer")
    .constructor<emscripten::val>()
    .function("init",    &Remuxer::init)
    .function("read",    &Remuxer::read)
    .function("seek",    &Remuxer::seek)
    .function("destroy", &Remuxer::destroy)
    .function("extractThumbnail", &Remuxer::extractThumbnail);
}
