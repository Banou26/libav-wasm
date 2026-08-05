#include <emscripten.h>
#include <emscripten/val.h>
#include <emscripten/bind.h>
#include <vector>
#include <sstream>
#include <string>
#include <cstring>
#include <numeric>

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

// the mp4 muxer refuses both under empty_moov, and with no exception support that refusal aborts the module
static inline bool needs_transcoding_to_aac(AVCodecID codec_id) {
  return codec_id == AV_CODEC_ID_EAC3 || codec_id == AV_CODEC_ID_AC3;
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

typedef struct AudioStream {
  int streamIndex;
  std::string language;
  std::string title;
} AudioStream;

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
  std::vector<AudioStream> audio_streams;
  IOInfo info;
  std::vector<uint8_t> attachments_data;
  std::vector<Index> indexes;
  std::vector<Chapter> chapters;
  std::vector<uint8_t> video_extradata;
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

typedef struct ThumbnailReadResult {
  emscripten::val data;
  long offset;
  double pts;
  double duration;
  bool cancelled;
} ThumbnailReadResult;

// everything the thumbnail path needs from a file, none of which involves an output muxer
typedef struct ThumbnailInitResult {
  double duration;
  std::string video_mime_type;
  std::vector<uint8_t> video_extradata;
  std::vector<Index> indexes;
} ThumbnailInitResult;

// `data` is tightly packed RGBA at width * height * 4, ready for an ImageData with no further conversion
typedef struct ThumbnailDecodeResult {
  emscripten::val data;
  int width;
  int height;
  double pts;
  double duration;
  bool cancelled;
} ThumbnailDecodeResult;

class Remuxer {
public:
  AVIOContext* input_avio_context = nullptr;
  AVIOContext* output_avio_context = nullptr;
  AVFormatContext* output_format_context = nullptr;
  AVFormatContext* input_format_context = nullptr;

  const AVCodec *audio_avc = nullptr;
  AVStream *audio_avs = nullptr;
  AVCodecContext *audio_avcc = nullptr;
  int audio_index = -1;

  // decoding video happens only for thumbnails, so all of this is built on the first decode_keyframe call
  const AVCodec *video_decoder_avc = nullptr;
  AVCodecContext *video_decoder_avcc = nullptr;
  SwsContext *thumbnail_sws = nullptr;
  int thumbnail_sws_source_width = 0;
  int thumbnail_sws_source_height = 0;
  AVPixelFormat thumbnail_sws_source_format = AV_PIX_FMT_NONE;
  int thumbnail_sws_width = 0;
  int thumbnail_sws_height = 0;
  std::vector<uint8_t> thumbnail_vector;

  const AVCodec *audio_decoder_avc = nullptr;
  AVCodecContext *audio_decoder_avcc = nullptr;
  AVFrame *audio_input_frame = nullptr;
  AVFrame *audio_output_frame = nullptr;
  bool needs_audio_transcoding = false;

  uint8_t **audio_buffer = nullptr;
  int audio_buffer_size = 0;
  int audio_buffer_samples = 0;
  // standard AAC frame; codecpar->frame_size, audio_output_frame->nb_samples and the encoder buffer split all follow this
  int aac_frame_size = 1024;
  int64_t next_audio_pts = 0;
  bool audio_pts_initialized = false;

  int64_t last_video_dts = AV_NOPTS_VALUE;
  int64_t last_audio_dts = AV_NOPTS_VALUE;
  int64_t pts_offset = 0;
  bool after_seek = false;

  uint8_t* input_avio_buffer = nullptr;
  uint8_t* output_avio_buffer = nullptr;

  int64_t currentOffset = 0;
  int64_t input_length = 0;

  int buffer_size;
  int video_stream_index;
  int number_of_streams;
  // input stream index -> output stream index; -1 excludes the stream from the mp4 output (subtitles, attachments, non-selected audio) and drops its packets
  int* streams_list = nullptr;

  double prev_duration = 0;
  double prev_pts = 0;
  long   prev_pos = 0;
  double duration = 0;
  double pts = 0;
  long   pos = 0;

  std::string video_mime_type;
  std::string audio_mime_type;

  bool initializing = false;
  bool first_initialization_done = false;
  int init_buffer_count = 0;
  std::vector<std::string> init_vector;
  std::vector<uint8_t> write_vector;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;
  std::vector<AudioStream> audio_streams;
  int selected_audio_index = -1;

  emscripten::val resolved_promise = val::undefined();
  emscripten::val read_data_function = val::undefined();

  AVPacket* packet = nullptr;
  bool wrote = false;

  Remuxer(emscripten::val options) {
    resolved_promise = options["resolvedPromise"];
    input_length = options["length"].as<float>();
    buffer_size = options["bufferSize"].as<int>();
    selected_audio_index = options["audioStreamIndex"].isUndefined() ? -1 : options["audioStreamIndex"].as<int>();
    needs_audio_transcoding = false;
    next_audio_pts = 0;
    audio_pts_initialized = false;
  }

  ~Remuxer() {
    destroy();
  }

  // Takes effect on the next seek, which rebuilds the stream mapping.
  void set_audio_stream_index(int index) {
    selected_audio_index = index;
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
      case FF_PROFILE_AAC_HE_V2:return "mp4a.40.29";  // HE-AAC v2 (SBR+PS)
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

  int fill_stream_info(AVStream *avs, const AVCodec **avc, AVCodecContext **avcc) {
    *avc = avcodec_find_decoder(avs->codecpar->codec_id);
    if (!*avc) {
        printf("failed to find the codec\n"); return -1;
    }

    *avcc = avcodec_alloc_context3(*avc);
    if (!*avcc) {
        printf("failed to alloc memory for codec context\n"); return -1;
    }

    if (avcodec_parameters_to_context(*avcc, avs->codecpar) < 0) {
        printf("failed to fill codec context\n"); return -1;
    }

    if (avcodec_open2(*avcc, *avc, NULL) < 0) {
        printf("failed to open codec\n"); return -1;
    }
    return 0;
  }

  int prepare_audio_encoder(){
    if (!needs_audio_transcoding) {
        return 0;
    }

    AVStream* output_audio_stream = nullptr;
    for (int i = 0; i < output_format_context->nb_streams; i++) {
        if (output_format_context->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            output_audio_stream = output_format_context->streams[i];
            break;
        }
    }

    if (!output_audio_stream) {
        printf("No audio output stream found\n");
        return -1;
    }

    audio_avc = avcodec_find_encoder_by_name("aac");
    if (!audio_avc) {
        printf("could not find AAC encoder\n");
        return -1;
    }

    audio_avcc = avcodec_alloc_context3(audio_avc);
    if (!audio_avcc) {
        printf("could not allocate memory for codec context\n");
        return -1;
    }

    int sample_rate = audio_decoder_avcc->sample_rate;
    int input_channels = audio_decoder_avcc->ch_layout.nb_channels;
    if (input_channels > 2) input_channels = 2;

    av_channel_layout_default(&audio_avcc->ch_layout, input_channels);
    audio_avcc->sample_rate = sample_rate;
    // the AAC encoder takes float planar input only
    audio_avcc->sample_fmt = AV_SAMPLE_FMT_FLTP;
    audio_avcc->bit_rate = 196000;
    audio_avcc->time_base = (AVRational){1, sample_rate};
    audio_avcc->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

    if (avcodec_open2(audio_avcc, audio_avc, NULL) < 0) {
        printf("could not open AAC encoder\n");
        return -1;
    }

    avcodec_parameters_from_context(output_audio_stream->codecpar, audio_avcc);
    output_audio_stream->time_base = audio_avcc->time_base;

    // required by the mp4 muxer, avcodec_parameters_from_context does not set it
    output_audio_stream->codecpar->frame_size = aac_frame_size;

    audio_output_frame->format = audio_avcc->sample_fmt;
    audio_output_frame->ch_layout = audio_avcc->ch_layout;
    audio_output_frame->sample_rate = audio_avcc->sample_rate;
    audio_output_frame->nb_samples = aac_frame_size;

    if (av_frame_get_buffer(audio_output_frame, 0) < 0) {
        printf("Could not allocate audio output frame buffer\n");
        return -1;
    }

    int output_channels = audio_avcc->ch_layout.nb_channels;
    audio_buffer_size = av_samples_get_buffer_size(NULL, output_channels, aac_frame_size * 4, audio_avcc->sample_fmt, 0);
    audio_buffer = (uint8_t**)av_calloc(output_channels, sizeof(uint8_t*));
    for (int i = 0; i < output_channels; i++) {
        audio_buffer[i] = (uint8_t*)av_malloc(audio_buffer_size);
    }
    audio_buffer_samples = 0;

    return 0;
  }

  int send_audio_frame_to_encoder(AVFrame *frame, AVStream *out_stream) {
    AVPacket *output_packet = av_packet_alloc();
    if (!output_packet) {
        printf("could not allocate memory for output packet\n");
        return -1;
    }

    int response = avcodec_send_frame(audio_avcc, frame);

    while (response >= 0) {
      response = avcodec_receive_packet(audio_avcc, output_packet);
      if (response == AVERROR(EAGAIN) || response == AVERROR_EOF) {
        break;
      } else if (response < 0) {
        printf("Error while receiving packet from encoder: %s\n", av_err2str(response));
        av_packet_free(&output_packet);
        return -1;
      }

      output_packet->stream_index = streams_list[audio_index];
      av_packet_rescale_ts(output_packet, audio_avcc->time_base, out_stream->time_base);

      response = av_interleaved_write_frame(output_format_context, output_packet);
      if (response != 0) {
          printf("Error %d while writing encoded packet: %s\n", response, av_err2str(response));
          av_packet_free(&output_packet);
          return -1;
      }
      av_packet_unref(output_packet);
    }
    av_packet_free(&output_packet);
    return 0;
  }

  int encode_audio(AVFrame *input_frame, AVStream *out_stream) {
    if (!needs_audio_transcoding || !audio_buffer) {
        return send_audio_frame_to_encoder(input_frame, out_stream);
    }

    int channels = audio_avcc->ch_layout.nb_channels;
    int sample_size = av_get_bytes_per_sample(audio_avcc->sample_fmt);
    int input_samples = input_frame->nb_samples;

    for (int ch = 0; ch < channels; ch++) {
        memcpy(audio_buffer[ch] + (audio_buffer_samples * sample_size),
               input_frame->data[ch],
               input_samples * sample_size);
    }
    audio_buffer_samples += input_samples;

    while (audio_buffer_samples >= aac_frame_size) {
        for (int ch = 0; ch < channels; ch++) {
            memcpy(audio_output_frame->data[ch],
                   audio_buffer[ch],
                   aac_frame_size * sample_size);
        }

        audio_output_frame->nb_samples = aac_frame_size;
        audio_output_frame->pts = next_audio_pts;
        // works only because the encoder time_base is {1, sample_rate}, so one sample is one tick; any other time base drifts silently
        next_audio_pts += aac_frame_size;

        if (send_audio_frame_to_encoder(audio_output_frame, out_stream) < 0) {
            return -1;
        }

        int remaining_samples = audio_buffer_samples - aac_frame_size;
        if (remaining_samples > 0) {
            for (int ch = 0; ch < channels; ch++) {
                memmove(audio_buffer[ch],
                        audio_buffer[ch] + (aac_frame_size * sample_size),
                        remaining_samples * sample_size);
            }
        }
        audio_buffer_samples = remaining_samples;
    }

    return 0;
  }

  int flush_audio_buffer(AVStream *out_stream) {
    if (!needs_audio_transcoding || !audio_buffer || audio_buffer_samples == 0) {
        return 0;
    }

    int channels = audio_avcc->ch_layout.nb_channels;
    int sample_size = av_get_bytes_per_sample(audio_avcc->sample_fmt);

    for (int ch = 0; ch < channels; ch++) {
        memcpy(audio_output_frame->data[ch], audio_buffer[ch], audio_buffer_samples * sample_size);
        memset(audio_output_frame->data[ch] + (audio_buffer_samples * sample_size), 0,
               (aac_frame_size - audio_buffer_samples) * sample_size);
    }

    audio_output_frame->nb_samples = aac_frame_size;
    audio_output_frame->pts = next_audio_pts;
    next_audio_pts += aac_frame_size;
    int result = send_audio_frame_to_encoder(audio_output_frame, out_stream);
    audio_buffer_samples = 0;

    return result;
  }

  int transcode_audio(AVPacket *input_packet, AVStream *out_stream) {
    int response = avcodec_send_packet(audio_decoder_avcc, input_packet);
    if (response < 0) {
        printf("Error while sending packet to decoder: %s\n", av_err2str(response));
        return response;
    }

    while (response >= 0) {
      response = avcodec_receive_frame(audio_decoder_avcc, audio_input_frame);
      if (response == AVERROR(EAGAIN) || response == AVERROR_EOF) {
        break;
      } else if (response < 0) {
        printf("Error while receiving frame from decoder: %s\n", av_err2str(response));
        return response;
      }

      if (response >= 0) {
        if (!audio_pts_initialized && input_packet->pts != AV_NOPTS_VALUE) {
          next_audio_pts = av_rescale_q(input_packet->pts,
                                        input_format_context->streams[audio_index]->time_base,
                                        audio_avcc->time_base);
          audio_pts_initialized = true;
        }
        if (encode_audio(audio_input_frame, out_stream)) return -1;
      }
      av_frame_unref(audio_input_frame);
    }
    return 0;
  }

  int prepare_decoder() {
    if (audio_index < 0) return 0;
    audio_avs = input_format_context->streams[audio_index];

    if (needs_audio_transcoding) {
        if (fill_stream_info(audio_avs, &audio_decoder_avc, &audio_decoder_avcc))
            return -1;

        audio_input_frame = av_frame_alloc();
        if (!audio_input_frame) {
            printf("Could not allocate audio input frame\n");
            return -1;
        }

        audio_output_frame = av_frame_alloc();
        if (!audio_output_frame) {
            printf("Could not allocate audio output frame\n");
            return -1;
        }
    }
    return 0;
  }

  // Returns the requested audioStreamIndex when valid, else the first audio stream.
  int collect_audio_streams() {
    audio_streams.clear();
    audio_index = -1;
    int first_audio = -1;
    bool selected_valid = false;
    for (int i = 0; i < input_format_context->nb_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      if (in_stream->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
      if (first_audio < 0) first_audio = i;
      if (i == selected_audio_index) selected_valid = true;
      AudioStream audio_stream;
      audio_stream.streamIndex = i;
      if (auto lang = av_dict_get(in_stream->metadata, "language", NULL, 0)) audio_stream.language = lang->value;
      if (auto title = av_dict_get(in_stream->metadata, "title", NULL, 0)) audio_stream.title = title->value;
      audio_streams.push_back(audio_stream);
    }
    return selected_valid ? selected_audio_index : first_audio;
  }

  void init_input(bool skip = false) {
    input_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    // args after the buffer size: 0 = not writing, this = opaque, avio_read = custom read, nullptr = no write, avio_seek = custom seek
    input_avio_context = avio_alloc_context(
      input_avio_buffer,
      buffer_size,
      0,
      this,
      avio_read,
      nullptr,
      avio_seek
    );
    input_format_context = avformat_alloc_context();
    input_format_context->pb = input_avio_context;

    // this branch carries an AVDictionary of analyzeduration/probesize tuning for codec detection during seek, both av_dict_set calls disabled for now; do not collapse it into the else
    if (skip) {
      AVDictionary* opts = nullptr;
      int ret = avformat_open_input(&input_format_context, NULL, nullptr, &opts);
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
    // args after the buffer size: 1 = write flag, this = opaque, nullptr = no read, avio_write = custom write, nullptr = no seek
    output_avio_context = avio_alloc_context(
      output_avio_buffer,
      buffer_size,
      1,
      this,
      nullptr,
      avio_write,
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

  // input-only discovery, shared by both init_streams branches and by the thumbnail path, which has no output
  void find_video_stream() {
    int ret = avformat_find_stream_info(input_format_context, nullptr);
    if (ret < 0) {
      throw std::runtime_error(
        "Could not find stream info: " + ffmpegErrStr(ret)
      );
    }

    number_of_streams = input_format_context->nb_streams;

    for (int i = 0; i < number_of_streams; i++) {
      AVCodecParameters* in_codecpar = input_format_context->streams[i]->codecpar;
      if (in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO) continue;
      video_stream_index = i;
      if (in_codecpar->codec_id == AV_CODEC_ID_H264) {
        video_mime_type = parse_h264_mime_type(in_codecpar);
      } else if (in_codecpar->codec_id == AV_CODEC_ID_H265) {
        video_mime_type = parse_h265_mime_type(in_codecpar);
      }
    }
  }

  void init_streams(bool skip = false) {
    find_video_stream();
    av_freep(&streams_list);

    if (skip) {
      streams_list = (int*)av_calloc(number_of_streams, sizeof(*streams_list));
      if (!streams_list) {
        throw std::runtime_error("Could not allocate streams_list");
      }

      const int effective_audio = collect_audio_streams();

      int out_index = 0;
      for (int i = 0; i < number_of_streams; i++) {
        AVStream* in_stream = input_format_context->streams[i];
        AVCodecParameters* in_codecpar = in_stream->codecpar;
        if (!(
          in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO ||
          in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO
        )) {
          streams_list[i] = -1;
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO && i != effective_audio) {
          streams_list[i] = -1;
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
          audio_index = i;
          if (needs_transcoding_to_aac(in_codecpar->codec_id)) {
            needs_audio_transcoding = true;
            audio_mime_type = "mp4a.40.2"; // describes the AAC-LC output, not the compressed input
          }
        }

        AVStream* out_stream = avformat_new_stream(output_format_context, nullptr);
        if (!out_stream) {
          throw std::runtime_error("Could not allocate an output stream");
        }

        // EAC3 params are copied as-is on purpose: prepare_audio_encoder runs later in init() and overwrites them with the AAC encoder params
        int cpRet = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
        if (cpRet < 0) {
          throw std::runtime_error(
            "Could not copy codec parameters: " + ffmpegErrStr(cpRet)
          );
        }

        streams_list[i] = out_index++;
      }
      return;
    }

    streams_list = (int*)av_calloc(number_of_streams, sizeof(*streams_list));

    if (!streams_list) {
      throw std::runtime_error("Could not allocate streams_list");
    }

    const int effective_audio = collect_audio_streams();

    int out_index = 0;
    for (int i = 0; i < number_of_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      AVCodecParameters* in_codecpar = in_stream->codecpar;

      if (in_codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
        Attachment attachment;

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

      if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        SubtitleFragment subtitle_fragment = SubtitleFragment();
        subtitle_fragment.streamIndex = i;
        subtitle_fragment.isHeader = true;
        subtitle_fragment.start = 0;
        subtitle_fragment.end = 0;
        AVDictionaryEntry* lang = av_dict_get(in_stream->metadata, "language", NULL, 0);
        if (lang) subtitle_fragment.language = lang->value;
        AVDictionaryEntry* title = av_dict_get(in_stream->metadata, "title", NULL, 0);
        if (title) subtitle_fragment.title = title->value;
        std::string subtitle_data;
        subtitle_data.assign((char*)in_codecpar->extradata, in_codecpar->extradata_size);
        subtitle_fragment.data = subtitle_data;

        subtitles.push_back(subtitle_fragment);
        streams_list[i] = -1;
        continue;
      }

      if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO && i != effective_audio) {
        streams_list[i] = -1;
        continue;
      }

      if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        audio_index = i;
        if (in_codecpar->codec_id == AV_CODEC_ID_AAC) {
          audio_mime_type = parse_mp4a_mime_type(in_codecpar);
        } else if (needs_transcoding_to_aac(in_codecpar->codec_id)) {
          needs_audio_transcoding = true;
          audio_mime_type = "mp4a.40.2"; // describes the AAC-LC output, not the compressed input
        }
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
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "strict", "experimental", 0);
    av_dict_set(&opts, "c", "copy", 0);
    av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

    // synchronously drives the custom avio_write, which is how the mp4 init segment lands in write_vector and is returned as result.data
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

  // Leaves the keyframe at or before `timestamp` in `packet`, with pos/pts/duration updated to match.
  // False means there is nothing to hand back: a failed seek, a cancelled read, or EOF.
  bool seek_to_keyframe(double timestamp) {
    AVStream* video_stream = input_format_context->streams[video_stream_index];

    int64_t seek_target = av_rescale_q(
      timestamp * AV_TIME_BASE,
      AV_TIME_BASE_Q,
      video_stream->time_base
    );

    if (av_seek_frame(input_format_context, video_stream_index, seek_target, AVSEEK_FLAG_BACKWARD) < 0) {
      return false;
    }

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        if (ret == AVERROR_EXIT) return false;
        if (ret == AVERROR_EOF) {
          // deliberately does NOT flush or write a trailer the way the remuxing read() path does. Running
          // off the end while hunting a keyframe says nothing about the output, and finalizing a muxer
          // from here is the one way this path could ever damage a remux. It now only reads.
          av_packet_free(&packet);
          break;
        }
        av_packet_free(&packet);
        break;
      }

      // only the video stream can carry the keyframe, so this needs no output stream map at all
      if (packet->stream_index != video_stream_index) {
        av_packet_free(&packet);
        continue;
      }

      AVStream* in_stream = input_format_context->streams[packet->stream_index];

      bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

      duration += packet->duration * av_q2d(in_stream->time_base);

      if (is_keyframe) {
        pos = packet->pos;
        pts = packet->pts * av_q2d(in_stream->time_base);
        duration = packet->duration * av_q2d(in_stream->time_base);
        break;
      } else {
        av_packet_unref(packet);
        av_packet_free(&packet);
        continue;
      }
    }

    // The loop can exit at EOF/error with the packet already freed.
    return packet && packet->data && packet->size > 0;
  }

  bool open_video_decoder() {
    if (video_decoder_avcc) return true;

    AVStream* video_stream = input_format_context->streams[video_stream_index];
    video_decoder_avc = avcodec_find_decoder(video_stream->codecpar->codec_id);
    if (!video_decoder_avc) return false;

    video_decoder_avcc = avcodec_alloc_context3(video_decoder_avc);
    if (!video_decoder_avcc) return false;

    if (avcodec_parameters_to_context(video_decoder_avcc, video_stream->codecpar) < 0
        || avcodec_open2(video_decoder_avcc, video_decoder_avc, nullptr) < 0) {
      avcodec_free_context(&video_decoder_avcc);
      video_decoder_avcc = nullptr;
      return false;
    }
    return true;
  }

  ThumbnailReadResult read_keyframe(emscripten::val read_function, double timestamp) {
    resolved_promise.await();
    read_data_function = read_function;

    write_vector.clear();
    av_packet_free(&packet);

    ThumbnailReadResult result;

    if (!seek_to_keyframe(timestamp)) {
      result.cancelled = true;
      read_data_function = val::undefined();
      return result;
    }

    write_vector.assign(packet->data, packet->data + packet->size);

    emscripten::val js_write_vector = emscripten::val(
      emscripten::typed_memory_view(
        write_vector.size(),
        write_vector.data()
      )
    );

    result.data = js_write_vector;
    result.offset = pos;
    result.pts = pts;
    result.duration = duration;
    result.cancelled = false;

    read_data_function = val::undefined();
    return result;
  }

  /**
   * Decode that keyframe to RGBA here instead of handing the compressed packet out for WebCodecs to decode.
   * The build already carries the h264 and hevc decoders and swscale, so this needs no new dependency, and
   * it is what runs on a browser with no WebCodecs at all (Firefox for Android).
   *
   * Same instance-level caveat as read_keyframe: this seeks BACKWARD on the input, which the output muxer
   * cannot follow, so it must only ever run on a remuxer dedicated to thumbnails. Ripple gives it one by
   * calling makeRemuxer separately, and every call there stands up its own worker and its own Remuxer.
   */
  ThumbnailDecodeResult decode_keyframe(emscripten::val read_function, double timestamp, int out_width, int out_height) {
    resolved_promise.await();
    read_data_function = read_function;

    write_vector.clear();
    av_packet_free(&packet);

    ThumbnailDecodeResult result;
    result.width = 0;
    result.height = 0;
    result.pts = 0;
    result.duration = 0;
    result.cancelled = true;

    if (out_width <= 0 || out_height <= 0 || !seek_to_keyframe(timestamp) || !open_video_decoder()) {
      read_data_function = val::undefined();
      return result;
    }

    // a previous call left the decoder drained, and this one starts from its own seek regardless
    avcodec_flush_buffers(video_decoder_avcc);

    if (avcodec_send_packet(video_decoder_avcc, packet) < 0) {
      read_data_function = val::undefined();
      return result;
    }

    AVFrame* frame = av_frame_alloc();
    if (!frame) {
      read_data_function = val::undefined();
      return result;
    }

    int ret = avcodec_receive_frame(video_decoder_avcc, frame);
    if (ret == AVERROR(EAGAIN)) {
      // a decoder can hold its first frame back until it is told no more packets are coming
      avcodec_send_packet(video_decoder_avcc, nullptr);
      ret = avcodec_receive_frame(video_decoder_avcc, frame);
    }

    if (ret < 0 || frame->width <= 0 || frame->height <= 0) {
      av_frame_free(&frame);
      read_data_function = val::undefined();
      return result;
    }

    AVPixelFormat source_format = (AVPixelFormat)frame->format;
    if (!thumbnail_sws
        || thumbnail_sws_source_width != frame->width
        || thumbnail_sws_source_height != frame->height
        || thumbnail_sws_source_format != source_format
        || thumbnail_sws_width != out_width
        || thumbnail_sws_height != out_height) {
      sws_freeContext(thumbnail_sws);
      thumbnail_sws = sws_getContext(
        frame->width, frame->height, source_format,
        out_width, out_height, AV_PIX_FMT_RGBA,
        SWS_BILINEAR, nullptr, nullptr, nullptr
      );
      thumbnail_sws_source_width = frame->width;
      thumbnail_sws_source_height = frame->height;
      thumbnail_sws_source_format = source_format;
      thumbnail_sws_width = out_width;
      thumbnail_sws_height = out_height;
    }

    if (!thumbnail_sws) {
      av_frame_free(&frame);
      read_data_function = val::undefined();
      return result;
    }

    thumbnail_vector.assign((size_t)out_width * (size_t)out_height * 4, 0);
    uint8_t* destination_data[4] = { thumbnail_vector.data(), nullptr, nullptr, nullptr };
    int destination_linesize[4] = { out_width * 4, 0, 0, 0 };

    sws_scale(thumbnail_sws, frame->data, frame->linesize, 0, frame->height, destination_data, destination_linesize);

    result.data = emscripten::val(
      emscripten::typed_memory_view(
        thumbnail_vector.size(),
        thumbnail_vector.data()
      )
    );
    result.width = out_width;
    result.height = out_height;
    result.pts = pts;
    result.duration = duration;
    result.cancelled = false;

    av_frame_free(&frame);
    read_data_function = val::undefined();
    return result;
  }

  /**
   * Open a file for thumbnails only: no output muxer, no encoder, no stream map, no header.
   *
   * That is not a saving, it is the point. readKeyframe seeks BACKWARD on the input, which an output muxer
   * cannot follow, so a remuxer that also serves thumbnails can only be kept safe by convention. With no
   * muxer to damage, it is safe by construction, and files whose audio the muxer refuses outright still
   * produce thumbnails.
   */
  ThumbnailInitResult init_thumbnail(emscripten::val read_function) {
    read_data_function = read_function;

    init_input();
    find_video_stream();

    ThumbnailInitResult result;
    result.duration = (double)input_format_context->duration / (double)AV_TIME_BASE;
    result.video_mime_type = video_mime_type;

    // seeking to the start is what makes lavf populate the seeking cues this walks
    av_seek_frame(input_format_context, video_stream_index, 0, AVSEEK_FLAG_BACKWARD);

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

    AVCodecParameters* in_codecpar = in_stream->codecpar;
    if (in_codecpar->extradata && in_codecpar->extradata_size > 0) {
      result.video_extradata.assign(
        in_codecpar->extradata,
        in_codecpar->extradata + in_codecpar->extradata_size
      );
    }

    read_data_function = val::undefined();
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
    prepare_decoder();
    prepare_audio_encoder();
    write_header();
    initializing = false;
    first_initialization_done = true;

    IOInfo infoObj;
    infoObj.input.formatName  = input_format_context->iformat->name ? input_format_context->iformat->name : "";
    infoObj.input.mimeType    = input_format_context->iformat->mime_type ? input_format_context->iformat->mime_type : "";
    infoObj.input.duration    = (double)input_format_context->duration / (double)AV_TIME_BASE;
    infoObj.input.video_mime_type = video_mime_type;
    infoObj.input.audio_mime_type = audio_mime_type;

    infoObj.output.formatName = output_format_context->oformat->name ? output_format_context->oformat->name : "";
    infoObj.output.mimeType   = output_format_context->oformat->mime_type ? output_format_context->oformat->mime_type : "";
    infoObj.output.duration   = 0.0;
    infoObj.output.video_mime_type = video_mime_type;
    infoObj.output.audio_mime_type = audio_mime_type;

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
    result.audio_streams = audio_streams;
    result.info = infoObj;

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
    AVCodecParameters* in_codecpar = in_stream->codecpar;
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

    if (in_codecpar->extradata && in_codecpar->extradata_size > 0) {
      result.video_extradata.assign(
        in_codecpar->extradata,
        in_codecpar->extradata + in_codecpar->extradata_size
      );
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
      if (ret < 0) {
        if (ret == AVERROR_EXIT) {
          ReadResult cancelled_result;
          cancelled_result.cancelled = true;
          read_data_function = val::undefined();
          return cancelled_result;
        }
        if (ret == AVERROR_EOF) {
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

      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        SubtitleFragment subtitle_fragment;
        subtitle_fragment.streamIndex = packet->stream_index;
        subtitle_fragment.isHeader = false;
        subtitle_fragment.start = packet->pts;
        subtitle_fragment.end   = subtitle_fragment.start + packet->duration;
        std::string subtitle_data;
        subtitle_data.assign((char*)packet->data, packet->size);
        subtitle_fragment.data = subtitle_data;

        subtitles.push_back(subtitle_fragment);
        continue;
      }

      if (packet->stream_index >= number_of_streams
          || streams_list[packet->stream_index] < 0) {
        av_packet_free(&packet);
        continue;
      }

      if (packet->stream_index >= number_of_streams
          || streams_list[packet->stream_index] < 0) {
        continue;
      }

      AVStream* out_stream = output_format_context->streams[streams_list[packet->stream_index]];

      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        if (needs_audio_transcoding && needs_transcoding_to_aac(in_stream->codecpar->codec_id)) {
          if (transcode_audio(packet, out_stream) < 0) {
            printf("ERROR: could not transcode audio\n");
          }
        } else {
          av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

          if (after_seek && packet->dts != AV_NOPTS_VALUE) {
            if (last_audio_dts == AV_NOPTS_VALUE) {
              last_audio_dts = packet->dts;
            } else if (packet->dts < last_audio_dts) {
              // the mp4 muxer rejects non-monotonic dts, so force it forward and clamp pts up to match
              packet->dts = last_audio_dts + 1;
              if (packet->pts != AV_NOPTS_VALUE && packet->pts < packet->dts) {
                packet->pts = packet->dts;
              }
            }
            last_audio_dts = packet->dts;
          }

          if ((ret = av_interleaved_write_frame(output_format_context, packet)) < 0) {
            printf("ERROR: could not write interleaved frame | %s \n", av_err2str(ret));
          }
        }
        av_packet_unref(packet);
        av_packet_free(&packet);
        continue;
      }

      bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

      duration += packet->duration * av_q2d(in_stream->time_base);
      av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

      if (after_seek && packet->dts != AV_NOPTS_VALUE) {
        if (last_video_dts == AV_NOPTS_VALUE) {
          last_video_dts = packet->dts;
        } else if (packet->dts <= last_video_dts) {
          packet->dts = last_video_dts + 1;
          if (packet->pts != AV_NOPTS_VALUE && packet->pts < packet->dts) {
            packet->pts = packet->dts;
          }
        }
        last_video_dts = packet->dts;
      }

      if (packet->pts == AV_NOPTS_VALUE && packet->dts != AV_NOPTS_VALUE) {
        packet->pts = packet->dts;
      }

      if (is_keyframe) {
        prev_duration = duration;
        prev_pts = pts;
        prev_pos = pos;

        duration = 0;

        pts = packet->pts * av_q2d(out_stream->time_base);
        pos = packet->pos;

        if (after_seek) {
          after_seek = false;
        }
      }

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

    // unlike init(), this deliberately skips destroy_streams() and keeps video_mime_type/audio_mime_type, since init_streams(true) never re-derives video_mime_type
    destroy_input();
    destroy_output();

    av_packet_free(&packet);

    reset_fragment();
    write_vector.clear();
    clear_attachments();
    subtitles.clear();

    needs_audio_transcoding = false;

    initializing = true;
    init_input(true);
    init_output();
    init_streams(true);
    prepare_decoder();
    prepare_audio_encoder();
    write_header();
    initializing = false;
    write_vector.clear();
    subtitles.clear();
    wrote = false;

    if (needs_audio_transcoding) {
        audio_buffer_samples = 0;
        audio_pts_initialized = false;
    }

    last_video_dts = AV_NOPTS_VALUE;
    last_audio_dts = AV_NOPTS_VALUE;
    pts_offset = 0;
    after_seek = true;

    int ret = av_seek_frame(input_format_context, video_stream_index, timestamp, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
      printf("ERROR: av_seek_frame: %s\n", ffmpegErrStr(ret).c_str());
      ReadResult cancelled_result;
      cancelled_result.cancelled = true;
      read_data_function = val::undefined();
      return cancelled_result;
    }

    ReadResult read_result = read(read_function);
    return read_result;
  }

  void destroy() {
    destroy_streams();
    destroy_input();
    destroy_output();

    if (audio_input_frame) {
      av_frame_free(&audio_input_frame);
      audio_input_frame = nullptr;
    }
    if (audio_output_frame) {
      av_frame_free(&audio_output_frame);
      audio_output_frame = nullptr;
    }
    if (audio_buffer) {
      int channels = audio_avcc ? audio_avcc->ch_layout.nb_channels : 2;
      for (int i = 0; i < channels; i++) {
        if (audio_buffer[i]) av_free(audio_buffer[i]);
      }
      av_free(audio_buffer);
      audio_buffer = nullptr;
    }
    if (video_decoder_avcc) {
      avcodec_free_context(&video_decoder_avcc);
      video_decoder_avcc = nullptr;
    }
    if (thumbnail_sws) {
      sws_freeContext(thumbnail_sws);
      thumbnail_sws = nullptr;
    }
    if (audio_decoder_avcc) {
      avcodec_free_context(&audio_decoder_avcc);
      audio_decoder_avcc = nullptr;
    }
    if (audio_avcc) {
      avcodec_free_context(&audio_avcc);
      audio_avcc = nullptr;
    }
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

  static int avio_write_impl(void* opaque, const uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    self->wrote = true;
    std::vector<uint8_t> chunk(buf, buf + buf_size);
    memcpy(chunk.data(), buf, buf_size);
    self->write_vector.insert(self->write_vector.end(), chunk.begin(), chunk.end());

    return buf_size;
  }

  #if LIBAVFORMAT_VERSION_MAJOR >= 59
  static int avio_write(void* opaque, const uint8_t* buf, int buf_size) {
  #else
  static int avio_write(void* opaque, uint8_t* buf, int buf_size) {
  #endif
    return avio_write_impl(opaque, buf, buf_size);
  }
};

EMSCRIPTEN_BINDINGS(libav_wasm_simplified) {
  emscripten::register_vector<Attachment>("VectorAttachment");
  emscripten::register_vector<SubtitleFragment>("VectorSubtitleFragment");
  emscripten::register_vector<AudioStream>("VectorAudioStream");
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

  emscripten::value_object<AudioStream>("AudioStream")
    .field("streamIndex", &AudioStream::streamIndex)
    .field("language",    &AudioStream::language)
    .field("title",       &AudioStream::title);

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
    .field("audioStreams", &InitResult::audio_streams)
    .field("chapters",    &InitResult::chapters)
    .field("indexes",     &InitResult::indexes)
    .field("info",        &InitResult::info)
    .field("videoExtradata", &InitResult::video_extradata);

  emscripten::value_object<ReadResult>("ReadResult")
    .field("data",      &ReadResult::data)
    .field("subtitles", &ReadResult::subtitles)
    .field("offset",    &ReadResult::offset)
    .field("pts",       &ReadResult::pts)
    .field("duration",  &ReadResult::duration)
    .field("cancelled", &ReadResult::cancelled)
    .field("finished",  &ReadResult::finished);

  emscripten::value_object<ThumbnailReadResult>("ThumbnailReadResult")
    .field("data",      &ThumbnailReadResult::data)
    .field("offset",    &ThumbnailReadResult::offset)
    .field("pts",       &ThumbnailReadResult::pts)
    .field("duration",  &ThumbnailReadResult::duration)
    .field("cancelled", &ThumbnailReadResult::cancelled);

  emscripten::value_object<ThumbnailInitResult>("ThumbnailInitResult")
    .field("duration",       &ThumbnailInitResult::duration)
    .field("videoMimeType",  &ThumbnailInitResult::video_mime_type)
    .field("videoExtradata", &ThumbnailInitResult::video_extradata)
    .field("indexes",        &ThumbnailInitResult::indexes);

  emscripten::value_object<ThumbnailDecodeResult>("ThumbnailDecodeResult")
    .field("data",      &ThumbnailDecodeResult::data)
    .field("width",     &ThumbnailDecodeResult::width)
    .field("height",    &ThumbnailDecodeResult::height)
    .field("pts",       &ThumbnailDecodeResult::pts)
    .field("duration",  &ThumbnailDecodeResult::duration)
    .field("cancelled", &ThumbnailDecodeResult::cancelled);

  emscripten::class_<Remuxer>("Remuxer")
    .constructor<emscripten::val>()
    .function("init",    &Remuxer::init)
    .function("read",    &Remuxer::read)
    .function("seek",    &Remuxer::seek)
    .function("destroy", &Remuxer::destroy)
    .function("initThumbnail", &Remuxer::init_thumbnail)
    .function("readKeyframe", &Remuxer::read_keyframe)
    .function("decodeKeyframe", &Remuxer::decode_keyframe)
    .function("setAudioStreamIndex", &Remuxer::set_audio_stream_index);
}
