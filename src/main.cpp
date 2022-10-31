#include <vector>
#include <string>
#include <vector>
#include <inttypes.h>
#include <iostream>
#include <sstream>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <algorithm>
#include <thread>

using namespace emscripten;

extern "C" {
  #include <libavcodec/avcodec.h>
  #include <libavformat/avformat.h>
  #include <libavutil/avstring.h>
  #include <libavutil/timestamp.h>
  #include <libavutil/mathematics.h>
  #include <libavutil/imgutils.h>
};

int main() {
  EM_ASM({ Module.wasmTable = wasmTable; });
  // printf("Oz LibAV transmuxer init\n");
  return 0;
}

typedef struct MediaInfoObject {
  std::string formatName;
  std::string mimeType;
  double duration;
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

  class Transmuxer {
  public:
    AVIOContext* input_avio_context;
    AVIOContext* output_avio_context;
    AVFormatContext* output_format_context;
    AVFormatContext* input_format_context;
    std::stringstream input_stream;
    std::stringstream output_stream;
    std::stringstream output_input_stream;
    int used_input;
    int written_output = 0;
    int used_output_input;
    int keyframe_index;
    long last_frame_pts;
    long last_frame_duration;
    int time_base_num;
    int time_base_den;
    int frame_write_index;
    long last_keyframe_duration;
    long last_keyframe_pts;
    long last_keyframe_pos;
    long keyframe_duration;
    long keyframe_pts;
    long keyframe_pos;
    int ret, i;
    int stream_index;
    int *subtitle_decoder_list;
    int *streams_list;
    int64_t *last_mux_dts_list;
    int number_of_streams;
    bool should_demux;
    int processed_bytes = 0;
    int input_length;
    int buffer_size;
    int video_stream_index;
    bool seeking;
    int64_t seeking_timestamp = -2;
    val read = val::undefined();
    val attachment = val::undefined();
    val subtitle = val::undefined();
    val write = val::undefined();
    val seek = val::undefined();
    val error = val::undefined();
    bool done = false;

    static void print_dict(const AVDictionary *m)
    {
        AVDictionaryEntry *t = NULL;
        while ((t = av_dict_get(m, "", t, AV_DICT_IGNORE_SUFFIX)))
            printf("%s %s   ", t->key, t->value);
        printf("\n");
    }

    Transmuxer(val options) {
      std::string hostStr = val::global("location")["host"].as<std::string>();
      const char* str = hostStr.c_str();
      std::string hostStdString(str);
      std::string sdbxAppHost("sdbx.app");
      std::string localhostProxyHost("localhost:2345");
      if (strcmp(str, "dev.fkn.app") != 0 && strcmp(str, "fkn.app") != 0 && !strstr(hostStdString.c_str(), sdbxAppHost.c_str()) && strcmp(str, "localhost:1234") != 0 && !strstr(hostStdString.c_str(), localhostProxyHost.c_str())) return;

      input_length = options["length"].as<int>();
      buffer_size = options["bufferSize"].as<int>();
      read = options["read"];
      attachment = options["attachment"];
      subtitle = options["subtitle"];
      write = options["write"];
      seek = options["seek"];
      error = options["error"];
    }

    void init () {
      seeking = false;
      input_avio_context = NULL;
      input_format_context = avformat_alloc_context();
      output_format_context = avformat_alloc_context();

      should_demux = false;
      written_output = 0;
      stream_index = 0;
      subtitle_decoder_list = NULL;
      streams_list = NULL;
      last_mux_dts_list = NULL;
      number_of_streams = 0;

      // Initialize the input avio context
      unsigned char* buffer = (unsigned char*)av_malloc(buffer_size);
      input_avio_context = avio_alloc_context(
        buffer,
        buffer_size,
        0,
        reinterpret_cast<void*>(this),
        &readFunction,
        nullptr,
        &seekFunction
      );

      input_format_context->pb = input_avio_context;

      // Open the input stream and automatically recognise format
      int res;
      if ((res = avformat_open_input(&input_format_context, NULL, nullptr, nullptr)) < 0) {
        // printf("ERROR: %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        // printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }

      // Initialize the output avio context
      unsigned char* buffer2 = (unsigned char*)av_malloc(buffer_size);
      output_avio_context = avio_alloc_context(
        buffer2,
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

      number_of_streams = input_format_context->nb_streams;
      subtitle_decoder_list = (int *)av_calloc(number_of_streams, sizeof(*subtitle_decoder_list));
      streams_list = (int *)av_calloc(number_of_streams, sizeof(*streams_list));
      if (!(last_mux_dts_list = (int64_t *)av_calloc(number_of_streams, sizeof(int64_t)))) {
        return;
      }

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        // printf("No streams_list, %s \n", av_err2str(res));
        return;
      }

      // Loop through all of the input streams
      for (i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVStream *out_in_stream;
        AVCodecParameters *in_codecpar = in_stream->codecpar;

        // Filter out all non video/audio streams
        if (
          in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE &&
          in_codecpar->codec_type != AVMEDIA_TYPE_ATTACHMENT
        ) {
          streams_list[i] = -1;
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
          // print_dict(in_stream->metadata);
          auto codec = avcodec_find_decoder(in_codecpar->codec_id);
          auto codecCtx = avcodec_alloc_context3(codec);
          avcodec_parameters_to_context(codecCtx, in_codecpar);
          auto filename = av_dict_get(in_stream->metadata, "filename", NULL, AV_DICT_IGNORE_SUFFIX)->value;
          auto mimetype = av_dict_get(in_stream->metadata, "mimetype", NULL, AV_DICT_IGNORE_SUFFIX)->value;
          attachment(
            static_cast<std::string>(filename),
            static_cast<std::string>(mimetype),
            emscripten::val(
              emscripten::typed_memory_view(
                codecCtx->extradata_size,
                codecCtx->extradata
              )
            )
          );
          // printf("HEADER IS ATTACHMENT TYPE, %d %s %s \n", i, filename, mimetype);
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          // char buf[256];
          auto codec = avcodec_find_decoder(in_codecpar->codec_id);
          auto codecCtx = avcodec_alloc_context3(codec);
          avcodec_parameters_to_context(codecCtx, in_codecpar);
          // if ((res = avcodec_open2(codecCtx, codec, NULL)) < 0) {
          //   avcodec_string(buf, sizeof(buf), codecCtx, 0);
          //   printf("Failed to open subtitle codec %s \n", buf);
          // }
          // subtitle_decoder_list[i] = codec;

          codecCtx->subtitle_header = (uint8_t *)av_malloc(codecCtx->extradata_size + 1);
          if (!codecCtx->subtitle_header) {
            res = AVERROR(ENOMEM);
            continue;
          }
          if (codecCtx->extradata_size) {
            memcpy(codecCtx->subtitle_header, codecCtx->extradata, codecCtx->extradata_size);
          }
          codecCtx->subtitle_header[codecCtx->extradata_size] = 0;
          codecCtx->subtitle_header_size = codecCtx->extradata_size;
          // printf("HEADER IS SUBTITLE TYPE, %s \n", codecCtx->subtitle_header);
          // print_dict(in_stream->metadata);
          auto language = av_dict_get(in_stream->metadata, "language", NULL, AV_DICT_IGNORE_SUFFIX)->value;
          auto title = av_dict_get(in_stream->metadata, "title", NULL, AV_DICT_IGNORE_SUFFIX)->value;
          std::string data = reinterpret_cast<char *>(codecCtx->subtitle_header);
          subtitle(
            i,
            true,
            data,
            static_cast<std::string>(language),
            static_cast<std::string>(title)
          );
          continue;
        }

        // Assign the video stream index to a global variable (potentially used to seek)
        if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          video_stream_index = i;
        }

        streams_list[i] = stream_index++;
        // Open the output stream
        out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          // printf("Failed allocating output stream \n");
          res = AVERROR_UNKNOWN;
          return;
        }
        // Copy all of the input file codecs to the output file codecs
        if ((res = avcodec_parameters_copy(out_stream->codecpar, in_codecpar)) < 0) {
          // printf("Failed to copy codec parameters \n");
          return;
        }
      }

      AVDictionary* opts = NULL;

      // Force transmuxing instead of re-encoding by copying the codecs
      av_dict_set(&opts, "c", "copy", 0);
      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      // Fragment the MP4 output
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

      // https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga18b7b10bb5b94c4842de18166bc677cb
      // Writes the header of the output
      if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
        // printf("Error occurred when opening output file \n");
        return;
      }
    }


    // todo: try to implement subtitle decoding: https://gist.github.com/reusee/7372569
    void process(int size) {
      int res;
      AVPacket* packet = av_packet_alloc();
      AVFrame* pFrame;
      AVStream *in_stream, *out_stream;
      auto start_position = input_format_context->pb->pos;
      // Read through all buffered frames
      while ((res = av_read_frame(input_format_context, packet)) >= 0) {
        if (packet->stream_index >= number_of_streams || streams_list[packet->stream_index] < 0) {
          av_packet_unref(packet);
          continue;
        }

        in_stream  = input_format_context->streams[packet->stream_index];
        out_stream = output_format_context->streams[packet->stream_index];

        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          long start = packet->pts;
          long end = start + packet->duration;
          // printf("PACKET IS SUBTITLE TYPE, %lld %s %lld %lld\n", packet->pos, packet->data, start, end);
          std::string data = reinterpret_cast<char *>(packet->data);
          subtitle(
            packet->stream_index,
            false,
            data,
            start,
            end
          );
          continue;
        }

        bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

        // Rescale the PTS/DTS from the input time base to the output time base
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && is_keyframe) {
          time_base_num = out_stream->time_base.num;
          time_base_den = out_stream->time_base.den;
          keyframe_duration = packet->duration;
          keyframe_pts = packet->pts;
          keyframe_pos = packet->pos;
          // printf("packet PTS: %ld, POS: %ld \n", keyframe_pts, keyframe_pos);
        } else if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          last_frame_pts = packet->pts;
          last_frame_duration = packet->duration;
          // printf("LAST FRAME PTS: %ld, POS: %ld \n", last_frame_pts, last_frame_duration);
        }

        // automatic non monotonically increasing DTS correction from https://github.com/FFmpeg/FFmpeg/blob/5c66ee6351ae3523206f64e5dc6c1768e438ed34/fftools/ffmpeg_mux.c#L127
        // this fixes unplayable output files but skips frames, need to find a way to properly correct so no frames are skipped
        // if (!(output_format_context->flags & AVFMT_NOTIMESTAMPS)) {
        //   int64_t last_mux_dts = last_mux_dts_list[in_stream->index];
        //   if (packet->dts != AV_NOPTS_VALUE &&
        //       packet->pts != AV_NOPTS_VALUE &&
        //       packet->dts > packet->pts) {
        //     packet->pts =
        //     packet->dts = packet->pts + packet->dts + last_mux_dts + 1
        //             - FFMIN3(packet->pts, packet->dts, last_mux_dts + 1)
        //             - FFMAX3(packet->pts, packet->dts, last_mux_dts + 1);
        //   }

        //   if ((in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO || in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO || in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) &&
        //       packet->dts != AV_NOPTS_VALUE &&
        //       last_mux_dts != AV_NOPTS_VALUE
        //     ) {
        //       int64_t max = last_mux_dts + !(output_format_context->flags & AVFMT_TS_NONSTRICT);
        //       if (packet->dts < max) {
        //           if (packet->pts >= packet->dts) {
        //             packet->pts = FFMAX(packet->pts, max);
        //           }
        //           packet->dts = max;
        //           if (!error.isUndefined()) {
        //             error(false, static_cast<std::string>("non monotonicaly increasing DTS values"));
        //           }
        //       }
        //   }
        // }
        // last_mux_dts_list[in_stream->index] = packet->dts;

        frame_write_index = 0;
        // Write the frames to the output context
        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          // printf("av_interleaved_write_frame failed\n");
          break;
        }
        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && is_keyframe) {
          write(
            (long)input_format_context->pb->pos,
            NULL,
            time_base_num,
            time_base_den,
            last_frame_pts,
            last_frame_duration,
            last_keyframe_duration,
            last_keyframe_pts,
            last_keyframe_pos,
            -1
          );
        }
        av_packet_unref(packet);
        frame_write_index = 0;
        if (input_format_context->pb->pos >= start_position + ((int64_t)size)) {
          return;
        }
      }
      // av_write_trailer(output_format_context);
    }

    InfoObject getInfo () {
      return {
        .input = {
          .formatName = input_format_context->iformat->name,
          .mimeType = input_format_context->iformat->mime_type,
          .duration = static_cast<double>(input_format_context->duration)
        },
        .output = {
          .formatName = output_format_context->oformat->name,
          .mimeType = output_format_context->oformat->mime_type,
          .duration = static_cast<double>(output_format_context->duration)
        }
      };
    }

    int64_t getInputPosition () {
      return input_avio_context->pos;
    }

    int64_t getOutputPosition () {
      return output_avio_context->pos;
    }

    // https://stackoverflow.com/a/3062994/4465603
    // todo: check if using any of these might help
    // input_format_context->av_class, this has AVOption, which has {"seek2any", "allow seeking to non-keyframes on demuxer level when supported"
    // avformat_seek_file, maybe this could be used instead of av_seek_frame ?
    int _seek(int timestamp, int flags) {
      int res;
      printf("seeking\n");
      if ((res = av_seek_frame(input_format_context, video_stream_index, timestamp, flags)) < 0) {
        printf("av_seek_frame errored\n");
      }
      printf("seek done\n");
      return 0;
    }

    void close () {
      avformat_free_context(input_format_context);
      avformat_free_context(output_format_context);
      avio_close(input_avio_context);
      avio_close(output_avio_context);
    }
  };

  static int64_t seekFunction(void* opaque, int64_t offset, int whence) {
    auto& remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    auto& seek = remuxObject.seek;
    auto result = seek((long)offset, whence).as<long>();
    return result;
  }

  // todo: re-implement this when https://github.com/emscripten-core/emscripten/issues/16686 is fixed
  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    auto& remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    auto& read = remuxObject.read;
    val res = read((long)remuxObject.input_format_context->pb->pos, buf_size);
    std::string buffer = res["buffer"].as<std::string>();
    int buffer_size = res["size"].as<int>();
    remuxObject.used_input += buf_size;
    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }
    return buffer_size;
  }

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    auto& remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    auto& write = remuxObject.write;
    write(
      (long)remuxObject.input_format_context->pb->pos,
      emscripten::val(
        emscripten::typed_memory_view(
          buf_size,
          buf
        )
      ),
      remuxObject.time_base_num,
      remuxObject.time_base_den,
      remuxObject.last_frame_pts,
      remuxObject.last_frame_duration,
      remuxObject.last_keyframe_duration,
      remuxObject.last_keyframe_pts,
      remuxObject.last_keyframe_pos,
      remuxObject.frame_write_index
    );
    remuxObject.last_keyframe_duration = remuxObject.keyframe_duration;
    remuxObject.last_keyframe_pts = remuxObject.keyframe_pts;
    remuxObject.last_keyframe_pos = remuxObject.keyframe_pos;
    remuxObject.frame_write_index = remuxObject.frame_write_index + 1;

    return buf_size;
  }

  // Binding code
  EMSCRIPTEN_BINDINGS(my_class_example) {

    emscripten::value_object<MediaInfoObject>("MediaInfoObject")
      .field("formatName", &MediaInfoObject::formatName)
      .field("duration", &MediaInfoObject::duration)
      .field("mimeType", &MediaInfoObject::mimeType);

    emscripten::value_object<InfoObject>("InfoObject")
      .field("input", &InfoObject::input)
      .field("output", &InfoObject::output);

    class_<Transmuxer>("Transmuxer")
      .constructor<emscripten::val>()
      .function("init", &Transmuxer::init)
      .function("process", &Transmuxer::process)
      .function("close", &Transmuxer::close)
      .function("seek", &Transmuxer::_seek)
      .function("getInfo", &Transmuxer::getInfo);
  }
}
