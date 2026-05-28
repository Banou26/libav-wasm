#include <emscripten.h>
#include <emscripten/val.h>
#include <emscripten/bind.h>
#include <vector>
#include <deque>
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

// One already-encoded AAC unit handed to JS in transcode mode (timestamps in seconds).
struct AudioUnit {
  std::vector<uint8_t> data;
  double pts;
  double duration;
};

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

// Result of init_transcode(): everything JS needs to configure the WebCodecs
// VideoEncoder and the output mux (init_transcode_mux). No fMP4 header is produced
// here: the muxer is created later, once the encoder reports the H264 avcC.
typedef struct TranscodeInitResult {
  IOInfo info;
  std::vector<Attachment> attachments;
  std::vector<SubtitleFragment> subtitles;
  std::vector<Index> indexes;
  std::vector<Chapter> chapters;
  int video_width;
  int video_height;
  // avg frame rate as a rational, for encoder framerate / bitrate hints
  int video_fps_num;
  int video_fps_den;
  bool has_audio;
  int audio_sample_rate;
  int audio_channels;
  // AudioSpecificConfig (esds) for the output AAC, used to configure the muxer's audio track
  std::vector<uint8_t> audio_extradata;
  bool cancelled;
} TranscodeInitResult;

// One media unit produced by read_transcode(). Exactly one of video/audio per call,
// in demux order, or type == "eof"/"cancelled".
typedef struct TranscodeReadResult {
  std::string type; // "video" | "audio" | "eof" | "cancelled"
  emscripten::val data = emscripten::val::undefined(); // I420 (video) or AAC bytes (audio)
  int width = 0;
  int height = 0;
  // I420 plane strides (may include padding from sws); JS builds the VideoFrame layout from these
  int linesize0 = 0;
  int linesize1 = 0;
  int linesize2 = 0;
  bool key = false;
  double pts = 0;       // seconds
  double duration = 0;  // seconds
  bool finished = false;
  bool cancelled = false;
} TranscodeReadResult;

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

  // For transcoding (decoder)
  const AVCodec *audio_decoder_avc = nullptr;
  AVCodecContext *audio_decoder_avcc = nullptr;
  AVFrame *audio_input_frame = nullptr;
  AVFrame *audio_output_frame = nullptr;
  bool needs_audio_transcoding = false;

  // Frame buffering for AAC encoder
  uint8_t **audio_buffer = nullptr;
  int audio_buffer_size = 0;
  int audio_buffer_samples = 0;
  int aac_frame_size = 1024; // Standard AAC frame size
  int64_t next_audio_pts = 0; // Track cumulative timestamp
  bool audio_pts_initialized = false; // Track if we've set initial timestamp

  // Timestamp tracking for seek
  int64_t last_video_dts = AV_NOPTS_VALUE;
  int64_t last_audio_dts = AV_NOPTS_VALUE;
  int64_t pts_offset = 0;
  bool after_seek = false;

  // Video transcoding (HEVC -> raw I420 frames handed to JS for WebCodecs H264 encode).
  // Enabled only when the browser cannot play the input video codec natively (decided in JS).
  // In this mode read_transcode demuxes + decodes video to I420 and forwards audio packets
  // (already AAC, or AAC from the EAC3/AC3 -> AAC transcode) to JS. JS encodes the frames to
  // H264 with WebCodecs and pushes the encoded packets back via the init/write_transcode_mux
  // methods, which mux everything into fragmented MP4 using the same muxer as the passthrough path.
  bool video_transcode = false;
  // When true, read_transcode demuxes audio but drops video packets undecoded (cheap audio extract).
  bool skip_video_decode = false;
  const AVCodec *video_decoder_avc = nullptr;
  AVCodecContext *video_decoder_avcc = nullptr;
  AVFrame *video_decode_frame = nullptr;
  // Decoder thread count: 1 = single-threaded (default), 0 = auto (uses all cores), N = explicit.
  // Only has an effect when the module is built with pthreads (-pthread); otherwise libavcodec
  // stays single-threaded regardless of this value.
  int video_thread_count = 1;
  SwsContext *sws_ctx = nullptr;
  int sws_src_w = 0;
  int sws_src_h = 0;
  int sws_src_fmt = -1;
  // Scratch buffer reused for the media bytes returned by each read_transcode() call.
  // Safe to reuse because worker calls are serialized (p-queue concurrency 1) and JS copies
  // the typed_memory_view out before the next call.
  std::vector<uint8_t> media_scratch;
  // Pending decoded frames from the current packet (decoder may emit several per packet).
  std::deque<AVFrame*> pending_video_frames;
  // Audio units (already-encoded AAC bytes + timestamps in seconds) waiting to be emitted to JS.
  std::deque<AudioUnit> pending_audio;
  // When true, the AAC encoder output is captured into pending_audio (handed to JS) instead of
  // being muxed here (used for EAC3/AC3 -> AAC in transcode mode; muxing happens later in JS->WASM).
  bool capture_audio = false;

  // Output stream indices for the transcode mux sink (JS pushes WebCodecs-encoded H264 +
  // passthrough AAC back into the WASM mp4 muxer; see init_transcode_mux below).
  int transcode_video_out_index = -1;
  int transcode_audio_out_index = -1;

  // Set true when writing the transcode mux header so write_header() enables frag_duration.
  // Passthrough must not enable it — small mid-GOP fragments don't start with a keyframe and
  // the resulting stream isn't decodable. For transcode, we control the encoder and
  // WebCodecs `latencyMode: 'realtime'` keeps every frame independently decodable enough
  // for browsers to handle 500ms-fragmented output without choking.
  bool transcode_mux_mode = false;

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
  // Set after av_write_trailer() so subsequent read() calls return empty/finished without
  // re-flushing the muxer (which would write garbage bytes and break MSE).
  bool finalized = false;
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
    if (!options["threadCount"].isUndefined()) {
      video_thread_count = options["threadCount"].as<int>();
    }
    needs_audio_transcoding = false;
    next_audio_pts = 0;
    audio_pts_initialized = false;
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
        return 0; // No transcoding needed
    }

    // Find the output stream for audio in the output format
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

    // Use input stream parameters as basis
    int sample_rate = audio_decoder_avcc->sample_rate;
    int input_channels = audio_decoder_avcc->ch_layout.nb_channels;
    if (input_channels > 2) input_channels = 2; // Downmix to stereo if needed

    av_channel_layout_default(&audio_avcc->ch_layout, input_channels);
    audio_avcc->sample_rate = sample_rate;
    // Use appropriate sample format for AAC encoder
    audio_avcc->sample_fmt = AV_SAMPLE_FMT_FLTP; // AAC encoder typically uses float planar
    audio_avcc->bit_rate = 196000;
    audio_avcc->time_base = (AVRational){1, sample_rate};
    audio_avcc->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

    if (avcodec_open2(audio_avcc, audio_avc, NULL) < 0) {
        printf("could not open AAC encoder\n");
        return -1;
    }

    // Update the output stream with encoder parameters
    avcodec_parameters_from_context(output_audio_stream->codecpar, audio_avcc);
    output_audio_stream->time_base = audio_avcc->time_base;

    // Set frame_size for MP4 muxer
    output_audio_stream->codecpar->frame_size = aac_frame_size;

    // Set up output frame for AAC encoding
    audio_output_frame->format = audio_avcc->sample_fmt;
    audio_output_frame->ch_layout = audio_avcc->ch_layout;
    audio_output_frame->sample_rate = audio_avcc->sample_rate;
    audio_output_frame->nb_samples = aac_frame_size;

    if (av_frame_get_buffer(audio_output_frame, 0) < 0) {
        printf("Could not allocate audio output frame buffer\n");
        return -1;
    }

    // Allocate sample buffer for frame splitting
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

      // Transcode mode: hand the AAC bytes to JS (which pushes them back to the mux sink) instead
      // of muxing here.
      if (capture_audio) {
        AudioUnit unit;
        unit.data.assign(output_packet->data, output_packet->data + output_packet->size);
        unit.pts = (output_packet->pts == AV_NOPTS_VALUE ? 0 : output_packet->pts) * av_q2d(audio_avcc->time_base);
        unit.duration = output_packet->duration * av_q2d(audio_avcc->time_base);
        pending_audio.push_back(std::move(unit));
        av_packet_unref(output_packet);
        continue;
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

    // Copy input frame data to our buffer
    for (int ch = 0; ch < channels; ch++) {
        memcpy(audio_buffer[ch] + (audio_buffer_samples * sample_size),
               input_frame->data[ch],
               input_samples * sample_size);
    }
    audio_buffer_samples += input_samples;

    // Send complete frames to encoder
    while (audio_buffer_samples >= aac_frame_size) {
        // Copy one frame worth of samples to output frame
        for (int ch = 0; ch < channels; ch++) {
            memcpy(audio_output_frame->data[ch],
                   audio_buffer[ch],
                   aac_frame_size * sample_size);
        }

        audio_output_frame->nb_samples = aac_frame_size;
        audio_output_frame->pts = next_audio_pts;
        next_audio_pts += aac_frame_size; // Increment by frame size in encoder time base

        if (send_audio_frame_to_encoder(audio_output_frame, out_stream) < 0) {
            return -1;
        }

        // Shift remaining samples to beginning of buffer
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

    // Send remaining samples (pad with silence if needed)
    for (int ch = 0; ch < channels; ch++) {
        memcpy(audio_output_frame->data[ch], audio_buffer[ch], audio_buffer_samples * sample_size);
        // Pad with silence
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
        // Set initial timestamp from input packet, rescaled to encoder time base
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
    for (int i = 0; i < input_format_context->nb_streams; i++) {
        if (input_format_context->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            audio_avs = input_format_context->streams[i];
            audio_index = i;

            // Set up decoder for transcoding if needed
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
        } else {
            // printf("skipping streams other than audio\n");
        }
    }
    return 0;
  }

  // ----- H265 -> raw I420 transcode support (decode only; JS encodes + muxes) -----

  int prepare_video_decoder() {
    AVStream* vs = input_format_context->streams[video_stream_index];
    video_decoder_avc = avcodec_find_decoder(vs->codecpar->codec_id);
    if (!video_decoder_avc) { printf("failed to find video decoder\n"); return -1; }
    video_decoder_avcc = avcodec_alloc_context3(video_decoder_avc);
    if (!video_decoder_avcc) { printf("failed to alloc video decoder ctx\n"); return -1; }
    if (avcodec_parameters_to_context(video_decoder_avcc, vs->codecpar) < 0) {
      printf("failed to fill video decoder ctx\n"); return -1;
    }
    // Multi-threaded decode (no-op unless built with pthreads). thread_count 0 = auto-detect.
    if (video_thread_count != 1) {
      video_decoder_avcc->thread_count = video_thread_count;
      video_decoder_avcc->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    }
    if (avcodec_open2(video_decoder_avcc, video_decoder_avc, NULL) < 0) {
      printf("failed to open video decoder\n"); return -1;
    }
    video_decode_frame = av_frame_alloc();
    return video_decode_frame ? 0 : -1;
  }

  // Drop B-frames at decode (AVDISCARD_NONREF) to cut cost when the decoder can't keep realtime (4K).
  void set_video_decode_skip_nonref(bool on) {
    if (video_decoder_avcc) video_decoder_avcc->skip_frame = on ? AVDISCARD_NONREF : AVDISCARD_DEFAULT;
  }

  void set_skip_video_decode(bool on) { skip_video_decode = on; }

  // AAC encoder for EAC3/AC3 -> AAC in transcode mode, without an output muxer stream.
  int prepare_audio_encoder_no_mux() {
    audio_avc = avcodec_find_encoder_by_name("aac");
    if (!audio_avc) { printf("could not find AAC encoder\n"); return -1; }
    audio_avcc = avcodec_alloc_context3(audio_avc);
    if (!audio_avcc) { printf("could not alloc AAC encoder ctx\n"); return -1; }

    int sample_rate = audio_decoder_avcc->sample_rate;
    int input_channels = audio_decoder_avcc->ch_layout.nb_channels;
    if (input_channels > 2) input_channels = 2;

    av_channel_layout_default(&audio_avcc->ch_layout, input_channels);
    audio_avcc->sample_rate = sample_rate;
    audio_avcc->sample_fmt = AV_SAMPLE_FMT_FLTP;
    audio_avcc->bit_rate = 196000;
    audio_avcc->time_base = (AVRational){1, sample_rate};
    // GLOBAL_HEADER so the AudioSpecificConfig ends up in audio_avcc->extradata (needed by JS muxer).
    audio_avcc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    audio_avcc->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

    if (avcodec_open2(audio_avcc, audio_avc, NULL) < 0) { printf("could not open AAC encoder\n"); return -1; }

    audio_output_frame->format = audio_avcc->sample_fmt;
    audio_output_frame->ch_layout = audio_avcc->ch_layout;
    audio_output_frame->sample_rate = audio_avcc->sample_rate;
    audio_output_frame->nb_samples = aac_frame_size;
    if (av_frame_get_buffer(audio_output_frame, 0) < 0) { printf("could not alloc audio out frame\n"); return -1; }

    int output_channels = audio_avcc->ch_layout.nb_channels;
    audio_buffer_size = av_samples_get_buffer_size(NULL, output_channels, aac_frame_size * 4, audio_avcc->sample_fmt, 0);
    audio_buffer = (uint8_t**)av_calloc(output_channels, sizeof(uint8_t*));
    for (int i = 0; i < output_channels; i++) audio_buffer[i] = (uint8_t*)av_malloc(audio_buffer_size);
    audio_buffer_samples = 0;
    return 0;
  }

  void drain_video_decoder() {
    while (true) {
      int ret = avcodec_receive_frame(video_decoder_avcc, video_decode_frame);
      if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF || ret < 0) break;
      pending_video_frames.push_back(av_frame_clone(video_decode_frame));
      av_frame_unref(video_decode_frame);
    }
  }

  TranscodeReadResult emit_video_frame(AVFrame* frame) {
    AVStream* vs = input_format_context->streams[video_stream_index];
    int w = frame->width;
    int h = frame->height;
    int cw = (w + 1) / 2;
    int ch = (h + 1) / 2;

    if (!sws_ctx || sws_src_w != w || sws_src_h != h || sws_src_fmt != frame->format) {
      if (sws_ctx) { sws_freeContext(sws_ctx); sws_ctx = nullptr; }
      sws_ctx = sws_getContext(
        w, h, (AVPixelFormat)frame->format,
        w, h, AV_PIX_FMT_YUV420P,
        SWS_BILINEAR, NULL, NULL, NULL
      );
      sws_src_w = w; sws_src_h = h; sws_src_fmt = frame->format;
    }

    size_t y_size = (size_t)w * h;
    size_t c_size = (size_t)cw * ch;
    media_scratch.resize(y_size + 2 * c_size);
    uint8_t* dst_data[4] = {
      media_scratch.data(),
      media_scratch.data() + y_size,
      media_scratch.data() + y_size + c_size,
      nullptr
    };
    int dst_linesize[4] = { w, cw, cw, 0 };
    sws_scale(sws_ctx, frame->data, frame->linesize, 0, h, dst_data, dst_linesize);

    TranscodeReadResult r;
    r.type = "video";
    r.width = w;
    r.height = h;
    r.linesize0 = w;
    r.linesize1 = cw;
    r.linesize2 = cw;
    r.key = (frame->flags & AV_FRAME_FLAG_KEY) || frame->pict_type == AV_PICTURE_TYPE_I;
    int64_t best = frame->best_effort_timestamp != AV_NOPTS_VALUE ? frame->best_effort_timestamp : frame->pts;
    r.pts = (best == AV_NOPTS_VALUE ? 0 : best) * av_q2d(vs->time_base);
    r.duration = frame->duration * av_q2d(vs->time_base);
    if (r.duration <= 0) {
      AVRational fr = vs->avg_frame_rate;
      if (fr.num > 0) r.duration = av_q2d(av_inv_q(fr));
    }
    r.data = emscripten::val(emscripten::typed_memory_view(media_scratch.size(), media_scratch.data()));
    r.finished = false;
    r.cancelled = false;
    av_frame_free(&frame);
    return r;
  }

  TranscodeReadResult emit_audio_unit() {
    AudioUnit unit = std::move(pending_audio.front());
    pending_audio.pop_front();
    media_scratch = std::move(unit.data);
    TranscodeReadResult r;
    r.type = "audio";
    r.key = true;
    r.width = 0; r.height = 0;
    r.linesize0 = 0; r.linesize1 = 0; r.linesize2 = 0;
    r.pts = unit.pts;
    r.duration = unit.duration;
    r.data = emscripten::val(emscripten::typed_memory_view(media_scratch.size(), media_scratch.data()));
    r.finished = false;
    r.cancelled = false;
    return r;
  }

  void clear_transcode_buffers() {
    while (!pending_video_frames.empty()) {
      AVFrame* f = pending_video_frames.front();
      pending_video_frames.pop_front();
      av_frame_free(&f);
    }
    pending_audio.clear();
  }

  TranscodeInitResult init_transcode(emscripten::val read_function) {
    read_data_function = read_function;

    // Tear down any state from a prior passthrough init() (the worker probes codec support
    // with init() before deciding to transcode). All destroy_* helpers are null-safe.
    destroy_streams();
    destroy_input();
    destroy_output();
    av_packet_free(&packet);

    reset_fragment();
    clear_attachments();
    subtitles.clear();
    clear_transcode_buffers();
    video_mime_type.clear();
    audio_mime_type.clear();
    // Bypass the cached-bytes path in avio_read: this re-init reads fresh from JS, which also
    // ensures the call suspends (ASYNCIFY) so the JS wrapper sees a real Promise to .then on.
    first_initialization_done = false;
    init_vector.clear();
    init_buffer_count = 0;
    finalized = false;

    video_transcode = true;
    needs_audio_transcoding = false;
    capture_audio = false;
    audio_index = -1;
    video_stream_index = -1;

    initializing = true;
    init_input();
    int ret = avformat_find_stream_info(input_format_context, nullptr);
    if (ret < 0) throw std::runtime_error("Could not find stream info: " + ffmpegErrStr(ret));
    number_of_streams = input_format_context->nb_streams;

    for (int i = 0; i < number_of_streams; i++) {
      AVStream* in_stream = input_format_context->streams[i];
      AVCodecParameters* cp = in_stream->codecpar;

      if (cp->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
        Attachment attachment;
        if (auto fn = av_dict_get(in_stream->metadata, "filename", NULL, 0)) attachment.filename = fn->value;
        if (auto mt = av_dict_get(in_stream->metadata, "mimetype", NULL, 0)) attachment.mimetype = mt->value;
        attachment.size = cp->extradata_size;
        attachment.ptr = (size_t)malloc(attachment.size);
        std::memcpy((void*)attachment.ptr, cp->extradata, attachment.size);
        attachments.push_back(attachment);
        continue;
      }

      if (cp->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        SubtitleFragment sf = SubtitleFragment();
        sf.streamIndex = i;
        sf.isHeader = true;
        sf.start = 0;
        sf.end = 0;
        if (auto lang = av_dict_get(in_stream->metadata, "language", NULL, 0)) sf.language = lang->value;
        if (auto title = av_dict_get(in_stream->metadata, "title", NULL, 0)) sf.title = title->value;
        std::string subtitle_data;
        subtitle_data.assign((char*)cp->extradata, cp->extradata_size);
        sf.data = subtitle_data;
        subtitles.push_back(sf);
        continue;
      }

      if (cp->codec_type == AVMEDIA_TYPE_VIDEO && video_stream_index < 0) {
        video_stream_index = i;
        if (cp->codec_id == AV_CODEC_ID_H264) video_mime_type = parse_h264_mime_type(cp);
        else if (cp->codec_id == AV_CODEC_ID_H265) video_mime_type = parse_h265_mime_type(cp);
      }
      if (cp->codec_type == AVMEDIA_TYPE_AUDIO && audio_index < 0) {
        audio_index = i;
        if (cp->codec_id == AV_CODEC_ID_AAC) {
          audio_mime_type = parse_mp4a_mime_type(cp);
        } else if (cp->codec_id == AV_CODEC_ID_EAC3 || cp->codec_id == AV_CODEC_ID_AC3) {
          needs_audio_transcoding = true;
          audio_mime_type = "mp4a.40.2";
        }
      }
    }

    initializing = false;
    first_initialization_done = true;

    if (video_stream_index < 0) throw std::runtime_error("No video stream found for transcode");
    if (prepare_video_decoder() < 0) throw std::runtime_error("Could not open video decoder");

    if (audio_index >= 0 && needs_audio_transcoding) {
      capture_audio = true;
      if (prepare_decoder() < 0) throw std::runtime_error("Could not open audio decoder");
      if (prepare_audio_encoder_no_mux() < 0) throw std::runtime_error("Could not open audio encoder");
    }

    TranscodeInitResult result;
    AVStream* vs = input_format_context->streams[video_stream_index];
    result.video_width = vs->codecpar->width;
    result.video_height = vs->codecpar->height;
    AVRational fr = vs->avg_frame_rate.num ? vs->avg_frame_rate : av_guess_frame_rate(input_format_context, vs, nullptr);
    result.video_fps_num = fr.num;
    result.video_fps_den = fr.den ? fr.den : 1;

    if (audio_index >= 0) {
      AVStream* as = input_format_context->streams[audio_index];
      result.has_audio = true;
      bool enc = needs_audio_transcoding && audio_avcc;
      result.audio_sample_rate = enc ? audio_avcc->sample_rate : as->codecpar->sample_rate;
      result.audio_channels = enc ? audio_avcc->ch_layout.nb_channels : as->codecpar->ch_layout.nb_channels;
      const uint8_t* ed = enc ? audio_avcc->extradata : as->codecpar->extradata;
      int eds = enc ? audio_avcc->extradata_size : as->codecpar->extradata_size;
      if (ed && eds > 0) result.audio_extradata.assign(ed, ed + eds);
    } else {
      result.has_audio = false;
      result.audio_sample_rate = 0;
      result.audio_channels = 0;
    }

    IOInfo infoObj;
    infoObj.input.formatName = input_format_context->iformat->name ? input_format_context->iformat->name : "";
    infoObj.input.mimeType = input_format_context->iformat->mime_type ? input_format_context->iformat->mime_type : "";
    infoObj.input.duration = (double)input_format_context->duration / (double)AV_TIME_BASE;
    infoObj.input.video_mime_type = video_mime_type; // e.g. hev1.* (the unsupported input codec)
    infoObj.input.audio_mime_type = audio_mime_type;
    infoObj.output.formatName = "mp4";
    infoObj.output.mimeType = "video/mp4";
    infoObj.output.duration = infoObj.input.duration;
    infoObj.output.video_mime_type = ""; // JS fills this from the chosen avc encoder config
    infoObj.output.audio_mime_type = audio_mime_type;
    result.info = infoObj;

    for (int i = 0; i < input_format_context->nb_chapters; i++) {
      AVChapter* av_chapter = input_format_context->chapters[i];
      Chapter chapter;
      chapter.index = i;
      chapter.start = av_chapter->start * av_chapter->time_base.num / (float)av_chapter->time_base.den;
      chapter.end = av_chapter->end * av_chapter->time_base.num / (float)av_chapter->time_base.den;
      if (auto e = av_dict_get(av_chapter->metadata, "title", NULL, 0)) chapter.title = e->value;
      result.chapters.push_back(chapter);
    }

    av_seek_frame(input_format_context, video_stream_index, 0, AVSEEK_FLAG_BACKWARD);
    int nb_entries = avformat_index_get_entries_count(vs);
    for (int i = 0; i < nb_entries; i++) {
      const AVIndexEntry* entry = avformat_index_get_entry(vs, i);
      if (entry->flags & AVINDEX_KEYFRAME) {
        Index index;
        index.index = i;
        index.pos = entry->pos;
        index.timestamp = entry->timestamp * av_q2d(vs->time_base);
        result.indexes.push_back(index);
      }
    }

    result.attachments = attachments;
    result.subtitles = subtitles;
    result.cancelled = false;
    read_data_function = val::undefined();
    return result;
  }

  TranscodeReadResult read_transcode(emscripten::val read_function) {
    resolved_promise.await();
    read_data_function = read_function;
    media_scratch.clear();

    if (!pending_video_frames.empty()) {
      AVFrame* f = pending_video_frames.front();
      pending_video_frames.pop_front();
      auto r = emit_video_frame(f);
      read_data_function = val::undefined();
      return r;
    }
    if (!pending_audio.empty()) {
      auto r = emit_audio_unit();
      read_data_function = val::undefined();
      return r;
    }

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        av_packet_free(&packet);
        if (ret == AVERROR_EXIT) {
          TranscodeReadResult r;
          r.type = "cancelled";
          r.cancelled = true;
          read_data_function = val::undefined();
          return r;
        }
        // EOF: flush video decoder and audio encoder, then drain pending.
        if (!skip_video_decode) {
          avcodec_send_packet(video_decoder_avcc, nullptr);
          drain_video_decoder();
        }
        if (capture_audio && audio_avcc) {
          flush_audio_buffer(nullptr);
          send_audio_frame_to_encoder(nullptr, nullptr);
        }
        if (!pending_video_frames.empty()) {
          AVFrame* f = pending_video_frames.front();
          pending_video_frames.pop_front();
          auto r = emit_video_frame(f);
          r.finished = pending_video_frames.empty() && pending_audio.empty();
          read_data_function = val::undefined();
          return r;
        }
        if (!pending_audio.empty()) {
          auto r = emit_audio_unit();
          r.finished = pending_audio.empty();
          read_data_function = val::undefined();
          return r;
        }
        TranscodeReadResult r;
        r.type = "eof";
        r.finished = true;
        read_data_function = val::undefined();
        return r;
      }

      if (packet->stream_index == video_stream_index) {
        if (skip_video_decode) { av_packet_free(&packet); continue; } // audio-extract: drop video undecoded
        int sret = avcodec_send_packet(video_decoder_avcc, packet);
        av_packet_free(&packet);
        if (sret < 0) continue;
        drain_video_decoder();
        if (!pending_video_frames.empty()) {
          AVFrame* f = pending_video_frames.front();
          pending_video_frames.pop_front();
          auto r = emit_video_frame(f);
          read_data_function = val::undefined();
          return r;
        }
        continue;
      }

      if (packet->stream_index == audio_index) {
        if (needs_audio_transcoding) {
          transcode_audio(packet, nullptr); // out_stream unused while capture_audio is set
          av_packet_free(&packet);
          if (!pending_audio.empty()) {
            auto r = emit_audio_unit();
            read_data_function = val::undefined();
            return r;
          }
          continue;
        } else {
          AVStream* as = input_format_context->streams[audio_index];
          AudioUnit unit;
          unit.data.assign(packet->data, packet->data + packet->size);
          unit.pts = (packet->pts == AV_NOPTS_VALUE ? 0 : packet->pts) * av_q2d(as->time_base);
          unit.duration = packet->duration * av_q2d(as->time_base);
          pending_audio.push_back(std::move(unit));
          av_packet_free(&packet);
          auto r = emit_audio_unit();
          read_data_function = val::undefined();
          return r;
        }
      }

      // subtitle / other streams: not handled in the live read path yet
      av_packet_free(&packet);
    }
  }

  TranscodeReadResult seek_transcode(emscripten::val read_function, int timestamp) {
    resolved_promise.await();
    read_data_function = read_function;

    clear_transcode_buffers();
    av_packet_free(&packet);
    media_scratch.clear();

    if (video_decoder_avcc) avcodec_flush_buffers(video_decoder_avcc);
    if (audio_decoder_avcc) avcodec_flush_buffers(audio_decoder_avcc);
    if (capture_audio) {
      audio_buffer_samples = 0;
      audio_pts_initialized = false;
    }

    int ret = av_seek_frame(input_format_context, video_stream_index, timestamp, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) {
      TranscodeReadResult r;
      r.type = "cancelled";
      r.cancelled = true;
      read_data_function = val::undefined();
      return r;
    }
    return read_transcode(read_function);
  }

  TranscodeReadResult read_keyframe_transcode(emscripten::val read_function, double timestamp) {
    resolved_promise.await();
    read_data_function = read_function;
    media_scratch.clear();
    clear_transcode_buffers();
    av_packet_free(&packet);
    if (video_decoder_avcc) avcodec_flush_buffers(video_decoder_avcc);

    AVStream* vs = input_format_context->streams[video_stream_index];
    int64_t target = av_rescale_q(timestamp * AV_TIME_BASE, AV_TIME_BASE_Q, vs->time_base);
    if (av_seek_frame(input_format_context, video_stream_index, target, AVSEEK_FLAG_BACKWARD) < 0) {
      TranscodeReadResult r;
      r.type = "cancelled";
      r.cancelled = true;
      read_data_function = val::undefined();
      return r;
    }

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        av_packet_free(&packet);
        TranscodeReadResult r;
        r.type = "eof";
        r.finished = true;
        read_data_function = val::undefined();
        return r;
      }
      if (packet->stream_index != video_stream_index) {
        av_packet_free(&packet);
        continue;
      }
      avcodec_send_packet(video_decoder_avcc, packet);
      av_packet_free(&packet);
      drain_video_decoder();
      if (!pending_video_frames.empty()) {
        AVFrame* f = pending_video_frames.front();
        pending_video_frames.pop_front();
        clear_transcode_buffers(); // drop any extra decoded frames
        auto r = emit_video_frame(f);
        read_data_function = val::undefined();
        return r;
      }
    }
  }

  // ----- transcode mux sink -----
  // JS decodes (read_transcode) -> encodes I420 to H264 with the browser's WebCodecs
  // VideoEncoder -> pushes the encoded H264 packets (and passthrough AAC) back here, where the
  // existing fragmented-mp4 muxer turns them into the same fMP4 the passthrough path emits.
  // The muxer can only be created once the encoder reports the H264 avcC (extradata), which is
  // why this is a separate call from init_transcode.

  emscripten::val init_transcode_mux(
    emscripten::val video_extradata, // avcC reported by the WebCodecs encoder
    int width,
    int height,
    bool has_audio,
    emscripten::val audio_extradata, // AudioSpecificConfig (may be empty)
    int sample_rate,
    int channels
  ) {
    destroy_output();
    init_output();

    std::string vexd = video_extradata.as<std::string>();
    AVStream* vst = avformat_new_stream(output_format_context, nullptr);
    if (!vst) throw std::runtime_error("Could not allocate video output stream");
    vst->codecpar->codec_type = AVMEDIA_TYPE_VIDEO;
    vst->codecpar->codec_id = AV_CODEC_ID_H264;
    vst->codecpar->width = width;
    vst->codecpar->height = height;
    vst->codecpar->format = AV_PIX_FMT_YUV420P;
    vst->codecpar->codec_tag = 0;
    if (!vexd.empty()) {
      vst->codecpar->extradata = (uint8_t*)av_mallocz(vexd.size() + AV_INPUT_BUFFER_PADDING_SIZE);
      memcpy(vst->codecpar->extradata, vexd.data(), vexd.size());
      vst->codecpar->extradata_size = (int)vexd.size();
    }
    vst->time_base = (AVRational){1, 1000000}; // JS passes timestamps in microseconds
    transcode_video_out_index = vst->index;

    transcode_audio_out_index = -1;
    if (has_audio) {
      std::string aexd = audio_extradata.as<std::string>();
      AVStream* ast = avformat_new_stream(output_format_context, nullptr);
      if (!ast) throw std::runtime_error("Could not allocate audio output stream");
      ast->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
      ast->codecpar->codec_id = AV_CODEC_ID_AAC;
      ast->codecpar->sample_rate = sample_rate;
      av_channel_layout_default(&ast->codecpar->ch_layout, channels);
      ast->codecpar->codec_tag = 0;
      ast->codecpar->frame_size = aac_frame_size;
      if (!aexd.empty()) {
        ast->codecpar->extradata = (uint8_t*)av_mallocz(aexd.size() + AV_INPUT_BUFFER_PADDING_SIZE);
        memcpy(ast->codecpar->extradata, aexd.data(), aexd.size());
        ast->codecpar->extradata_size = (int)aexd.size();
      }
      ast->time_base = (AVRational){1, 1000000};
      transcode_audio_out_index = ast->index;
    }

    write_vector.clear();
    transcode_mux_mode = true;
    write_header();
    transcode_mux_mode = false;
    return emscripten::val(emscripten::typed_memory_view(write_vector.size(), write_vector.data()));
  }

  // Audio-only fMP4 sink for decode-render: video goes to a canvas, so only audio is muxed here to
  // feed the MSE timeline. Reuses write_transcode_audio / flush_transcode_mux.
  emscripten::val init_audio_only_mux(
    emscripten::val audio_extradata, // AudioSpecificConfig (may be empty)
    int sample_rate,
    int channels
  ) {
    destroy_output();
    init_output();

    std::string aexd = audio_extradata.as<std::string>();
    AVStream* ast = avformat_new_stream(output_format_context, nullptr);
    if (!ast) throw std::runtime_error("Could not allocate audio output stream");
    ast->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
    ast->codecpar->codec_id = AV_CODEC_ID_AAC;
    ast->codecpar->sample_rate = sample_rate;
    av_channel_layout_default(&ast->codecpar->ch_layout, channels);
    ast->codecpar->codec_tag = 0;
    ast->codecpar->frame_size = aac_frame_size;
    if (!aexd.empty()) {
      ast->codecpar->extradata = (uint8_t*)av_mallocz(aexd.size() + AV_INPUT_BUFFER_PADDING_SIZE);
      memcpy(ast->codecpar->extradata, aexd.data(), aexd.size());
      ast->codecpar->extradata_size = (int)aexd.size();
    }
    ast->time_base = (AVRational){1, 1000000};
    transcode_video_out_index = -1;
    transcode_audio_out_index = ast->index;

    write_vector.clear();
    transcode_mux_mode = true;
    write_header();
    transcode_mux_mode = false;
    return emscripten::val(emscripten::typed_memory_view(write_vector.size(), write_vector.data()));
  }

  emscripten::val write_transcode_video(emscripten::val data, double pts, double dts, double duration, bool keyframe) {
    write_vector.clear();
    std::string bytes = data.as<std::string>();
    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, (int)bytes.size());
    memcpy(pkt->data, bytes.data(), bytes.size());
    pkt->stream_index = transcode_video_out_index;
    pkt->pts = (int64_t)pts;
    pkt->dts = (int64_t)dts;
    pkt->duration = (int64_t)duration;
    if (keyframe) pkt->flags |= AV_PKT_FLAG_KEY;
    int ret = av_interleaved_write_frame(output_format_context, pkt);
    if (ret < 0) printf("write transcode video error: %s\n", av_err2str(ret));
    av_packet_free(&pkt);
    return emscripten::val(emscripten::typed_memory_view(write_vector.size(), write_vector.data()));
  }

  emscripten::val write_transcode_audio(emscripten::val data, double pts, double duration) {
    write_vector.clear();
    std::string bytes = data.as<std::string>();
    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, (int)bytes.size());
    memcpy(pkt->data, bytes.data(), bytes.size());
    pkt->stream_index = transcode_audio_out_index;
    pkt->pts = (int64_t)pts;
    pkt->dts = (int64_t)pts;
    pkt->duration = (int64_t)duration;
    pkt->flags |= AV_PKT_FLAG_KEY;
    int ret = av_interleaved_write_frame(output_format_context, pkt);
    if (ret < 0) printf("write transcode audio error: %s\n", av_err2str(ret));
    av_packet_free(&pkt);
    return emscripten::val(emscripten::typed_memory_view(write_vector.size(), write_vector.data()));
  }

  emscripten::val flush_transcode_mux() {
    write_vector.clear();
    if (output_format_context) {
      av_interleaved_write_frame(output_format_context, nullptr); // flush interleave queue
      av_write_trailer(output_format_context);
    }
    return emscripten::val(emscripten::typed_memory_view(write_vector.size(), write_vector.data()));
  }

  void init_input(bool skip = false) {
    input_avio_buffer = (uint8_t*)av_malloc(buffer_size);
    input_avio_context = avio_alloc_context(
      input_avio_buffer,
      buffer_size,
      0,                       // not writing
      this,                    // opaque
      avio_read,               // custom read
      nullptr,                 // no write
      avio_seek                // custom seek
    );
    input_format_context = avformat_alloc_context();
    input_format_context->pb = input_avio_context;

    if (skip) {
      AVDictionary* opts = nullptr;
      // Increase analyzeduration and probesize for better codec detection during seek
      // av_dict_set(&opts, "analyzeduration", "5000000", 0);  // 5 seconds
      // av_dict_set(&opts, "probesize", "10000000", 0);       // 10MB
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
      1,                       // write flag
      this,                    // opaque
      nullptr,                 // no read
      avio_write,             // custom write
      nullptr                 // no seek
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

      number_of_streams = input_format_context->nb_streams;
      streams_list = (int*)av_calloc(number_of_streams, sizeof(*streams_list));
      if (!streams_list) {
        throw std::runtime_error("Could not allocate streams_list");
      }

      int out_index = 0;
      for (int i = 0; i < number_of_streams; i++) {
        AVStream* in_stream = input_format_context->streams[i];
        AVCodecParameters* in_codecpar = in_stream->codecpar;
        if (!(
          in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO ||
          in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO
        )) {
          continue;
        }

        // Check if this is EAC3 audio that needs transcoding
        if (in_codecpar->codec_type == AVMEDIA_TYPE_AUDIO &&
            in_codecpar->codec_id == AV_CODEC_ID_EAC3) {
          needs_audio_transcoding = true;
          audio_mime_type = "mp4a.40.2"; // AAC-LC output
          audio_index = i;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          video_stream_index = i;
        }

        AVStream* out_stream = avformat_new_stream(output_format_context, nullptr);
        if (!out_stream) {
          throw std::runtime_error("Could not allocate an output stream");
        }

        // For EAC3 audio, we'll set AAC parameters later in prepare_audio_encoder
        // For now, just copy the parameters - they'll be overwritten if transcoding
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
        } else if (in_codecpar->codec_id == AV_CODEC_ID_EAC3) {
          needs_audio_transcoding = true;
          audio_mime_type = "mp4a.40.2"; // AAC-LC output
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
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "strict", "experimental", 0);
    av_dict_set(&opts, "c", "copy", 0);
    // frag_keyframe ends a fragment at every keyframe (the natural fMP4 boundary).
    // frag_duration also forces a fragment after N microseconds even if no keyframe yet.
    // Only enable frag_duration for the transcode mux: it cuts cold start ~5-9× by not
    // making the player wait for the whole encoded GOP before the first playable chunk.
    // For passthrough, mid-GOP fragments would start on a non-keyframe and break decode.
    av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);
    if (transcode_mux_mode) {
      av_dict_set(&opts, "frag_duration", "500000", 0);
    }

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

  ThumbnailReadResult read_keyframe(emscripten::val read_function, double timestamp) {
    resolved_promise.await();
    read_data_function = read_function;

    write_vector.clear();
    av_packet_free(&packet);

    AVStream* video_stream = input_format_context->streams[video_stream_index];

    // Convert timestamp to stream time base
    int64_t seek_target = av_rescale_q(
      timestamp * AV_TIME_BASE,
      AV_TIME_BASE_Q,
      video_stream->time_base
    );

    if (av_seek_frame(input_format_context, video_stream_index, seek_target, AVSEEK_FLAG_BACKWARD) < 0) {
      ThumbnailReadResult result;
      result.cancelled = true;
      return result;
    }

    while (true) {
      packet = av_packet_alloc();
      int ret = av_read_frame(input_format_context, packet);
      if (ret < 0) {
        if (ret == AVERROR_EXIT) {
          ThumbnailReadResult cancelled_result;
          cancelled_result.cancelled = true;
          read_data_function = val::undefined();
          return cancelled_result;
        }
        if (ret == AVERROR_EOF) {
          // flush + trailer
          avio_flush(output_format_context->pb);
          av_write_trailer(output_format_context);
          av_packet_free(&packet);
          break;
        }
        av_packet_free(&packet);
        break;
      }

      AVStream* in_stream = input_format_context->streams[packet->stream_index];

      // If it's a subtitle packet
      if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE || in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
        av_packet_free(&packet);
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

    ThumbnailReadResult result;

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

  InitResult init(emscripten::val read_function) {
    read_data_function = read_function;
    finalized = false;

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

    // Copy the extradata to the result
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

    // Already wrote the trailer; further reads must NOT call av_write_trailer again (would
    // emit garbage moov/mfra that MSE rejects with "timescale must not be 0").
    if (finalized) {
      ReadResult done;
      done.finished = true;
      done.data = emscripten::val(emscripten::typed_memory_view(write_vector.size(), write_vector.data()));
      read_data_function = val::undefined();
      return done;
    }

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
          // The trailer flushes the in-progress fragment, so it becomes the returned chunk.
          // prev_* tracks "what to return"; without this, a seek that lands in the last
          // fragment returns the previous fragment's pts (often 0 after a seek reset) and
          // the consumer offsets the buffer by 0 instead of the real start time.
          prev_pts = pts;
          prev_pos = pos;
          prev_duration = duration;
          finished = true;
          finalized = true;
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
        if (needs_audio_transcoding && in_stream->codecpar->codec_id == AV_CODEC_ID_EAC3) {
          // Transcode EAC3 to AAC
          if (transcode_audio(packet, out_stream) < 0) {
            printf("ERROR: could not transcode audio\n");
          }
        } else {
          // Direct copy for other audio formats
          av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

          // Fix timestamps after seek
          if (after_seek && packet->dts != AV_NOPTS_VALUE) {
            if (last_audio_dts == AV_NOPTS_VALUE) {
              // First packet after seek
              last_audio_dts = packet->dts;
            } else if (packet->dts < last_audio_dts) {
              // Non-monotonic timestamp detected, adjust
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
      // rescale timestamps
      av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

      // Fix timestamps after seek for video packets
      if (after_seek && packet->dts != AV_NOPTS_VALUE) {
        if (last_video_dts == AV_NOPTS_VALUE) {
          // First packet after seek
          last_video_dts = packet->dts;
        } else if (packet->dts <= last_video_dts) {
          // Non-monotonic timestamp detected, adjust
          packet->dts = last_video_dts + 1;
          if (packet->pts != AV_NOPTS_VALUE && packet->pts < packet->dts) {
            packet->pts = packet->dts;
          }
        }
        last_video_dts = packet->dts;
      }

      // Set proper timestamps for packets without them
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

        // Clear after_seek flag on keyframe since we've stabilized
        if (after_seek) {
          after_seek = false;
        }
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

    // Reset transcoding state
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
    finalized = false;

    // Reset audio transcoding buffer
    if (needs_audio_transcoding) {
        audio_buffer_samples = 0;
        audio_pts_initialized = false; // Reset so we get proper timestamp from seek position
    }

    // Reset timestamp tracking after seek
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

  //-----------------------------------------
  // Cleanup everything
  //-----------------------------------------
  void destroy() {
    destroy_streams();
    destroy_input();
    destroy_output();

    // Cleanup video transcode (HEVC decode) resources
    clear_transcode_buffers();
    if (sws_ctx) {
      sws_freeContext(sws_ctx);
      sws_ctx = nullptr;
    }
    if (video_decode_frame) {
      av_frame_free(&video_decode_frame);
      video_decode_frame = nullptr;
    }
    if (video_decoder_avcc) {
      avcodec_free_context(&video_decoder_avcc);
      video_decoder_avcc = nullptr;
    }

    // Cleanup transcoding resources
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

  // Compatibility wrapper for different FFmpeg versions
  static int avio_write_impl(void* opaque, const uint8_t* buf, int buf_size) {
    Remuxer* self = reinterpret_cast<Remuxer*>(opaque);

    self->wrote = true;
    std::vector<uint8_t> chunk(buf, buf + buf_size);
    memcpy(chunk.data(), buf, buf_size);
    self->write_vector.insert(self->write_vector.end(), chunk.begin(), chunk.end());

    return buf_size;
  }

  // Create function pointer with the correct signature for the current FFmpeg version
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

  emscripten::value_object<TranscodeInitResult>("TranscodeInitResult")
    .field("info",            &TranscodeInitResult::info)
    .field("attachments",     &TranscodeInitResult::attachments)
    .field("subtitles",       &TranscodeInitResult::subtitles)
    .field("indexes",         &TranscodeInitResult::indexes)
    .field("chapters",        &TranscodeInitResult::chapters)
    .field("videoWidth",      &TranscodeInitResult::video_width)
    .field("videoHeight",     &TranscodeInitResult::video_height)
    .field("videoFpsNum",     &TranscodeInitResult::video_fps_num)
    .field("videoFpsDen",     &TranscodeInitResult::video_fps_den)
    .field("hasAudio",        &TranscodeInitResult::has_audio)
    .field("audioSampleRate", &TranscodeInitResult::audio_sample_rate)
    .field("audioChannels",   &TranscodeInitResult::audio_channels)
    .field("audioExtradata",  &TranscodeInitResult::audio_extradata)
    .field("cancelled",       &TranscodeInitResult::cancelled);

  emscripten::value_object<TranscodeReadResult>("TranscodeReadResult")
    .field("type",      &TranscodeReadResult::type)
    .field("data",      &TranscodeReadResult::data)
    .field("width",     &TranscodeReadResult::width)
    .field("height",    &TranscodeReadResult::height)
    .field("linesize0", &TranscodeReadResult::linesize0)
    .field("linesize1", &TranscodeReadResult::linesize1)
    .field("linesize2", &TranscodeReadResult::linesize2)
    .field("key",       &TranscodeReadResult::key)
    .field("pts",       &TranscodeReadResult::pts)
    .field("duration",  &TranscodeReadResult::duration)
    .field("finished",  &TranscodeReadResult::finished)
    .field("cancelled", &TranscodeReadResult::cancelled);

  emscripten::class_<Remuxer>("Remuxer")
    .constructor<emscripten::val>()
    .function("init",    &Remuxer::init)
    .function("read",    &Remuxer::read)
    .function("seek",    &Remuxer::seek)
    .function("destroy", &Remuxer::destroy)
    .function("readKeyframe", &Remuxer::read_keyframe)
    .function("initTranscode",        &Remuxer::init_transcode)
    .function("readTranscode",        &Remuxer::read_transcode)
    .function("seekTranscode",        &Remuxer::seek_transcode)
    .function("readKeyframeTranscode", &Remuxer::read_keyframe_transcode)
    .function("initTranscodeMux",     &Remuxer::init_transcode_mux)
    .function("initAudioOnlyMux",     &Remuxer::init_audio_only_mux)
    .function("setVideoDecodeSkipNonref", &Remuxer::set_video_decode_skip_nonref)
    .function("setSkipVideoDecode",   &Remuxer::set_skip_video_decode)
    .function("writeTranscodeVideo",  &Remuxer::write_transcode_video)
    .function("writeTranscodeAudio",  &Remuxer::write_transcode_audio)
    .function("flushTranscodeMux",    &Remuxer::flush_transcode_mux);
}
