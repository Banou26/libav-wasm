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


  // #include "libavutil/avassert.h"
  // #include "libavutil/mathematics.h"
  // #include "libavutil/timestamp.h"

  // #include "libavformat/avio_internal.h"
  // #include "libavformat/demux.h"
  #include <libavformat/internal.h>
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
    unsigned char* input_avio_buffer;
    unsigned char* output_avio_buffer;
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
    int stream_index;
    int *streams_list;
    int number_of_streams;
    int input_length;
    int buffer_size;
    int video_stream_index;
    val read = val::undefined();
    val attachment = val::undefined();
    val subtitle = val::undefined();
    val write = val::undefined();
    val seek = val::undefined();
    val error = val::undefined();

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
      init_output_context(true);
    }

    void init_output_context (bool init) {
      int res;
      // if (!init) {
      //   // avio_flush(output_format_context->pb);
      //   // avformat_flush(output_format_context);
      //   // avio_flush(output_avio_context);
      //   avformat_free_context(input_format_context);
      //   avformat_close_input(&input_format_context);
      //   avio_context_free(&input_avio_context);
      //   avformat_close_input(&output_format_context);
      //   avformat_free_context(output_format_context);
      //   avio_context_free(&output_avio_context);
      //   av_free(input_avio_buffer);
      //   av_free(output_avio_buffer);
      // }

      last_frame_pts = NULL;
      last_frame_duration = NULL;
      time_base_num = NULL;
      time_base_den = NULL;
      frame_write_index = NULL;
      last_keyframe_duration = NULL;
      last_keyframe_pts = NULL;
      last_keyframe_pos = NULL;
      keyframe_duration = NULL;
      keyframe_pts = NULL;
      keyframe_pos = NULL;

      input_avio_context = NULL;
      input_format_context = avformat_alloc_context();
      output_format_context = avformat_alloc_context();

      stream_index = 0;
      streams_list = NULL;
      number_of_streams = 0;

      // Initialize the input avio context
      input_avio_buffer = (unsigned char*)av_malloc(buffer_size);
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
        // printf("ERROR: %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        // printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }
      
      output_avio_buffer = (unsigned char*)av_malloc(buffer_size);
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

      number_of_streams = input_format_context->nb_streams;
      streams_list = (int *)av_calloc(number_of_streams, sizeof(*streams_list));

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        // printf("No streams_list, %s \n", av_err2str(res));
        return;
      }

      // Loop through all of the input streams
      for (int i = 0; i < input_format_context->nb_streams; i++) {
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
          // if (!init) continue;
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
          avcodec_free_context(&codecCtx);
          // printf("HEADER IS ATTACHMENT TYPE, %d %s %s \n", i, filename, mimetype);
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          // if (!init) continue;
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
          avcodec_free_context(&codecCtx);
          av_free(codecCtx->subtitle_header);
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

      frame_write_index = -2;

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
        } else if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          last_frame_pts = packet->pts;
          last_frame_duration = packet->duration;
        }

        frame_write_index = 0;
        // Write the frames to the output context
        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          printf("av_interleaved_write_frame failed\n");
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
      av_packet_free(&packet);
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

    int _seek(int timestamp, int flags) {
      int res;
      // if (flags & AVSEEK_FLAG_BACKWARD) {
      //   init_output_context(false);
      // }
      if ((res = av_seek_frame(input_format_context, video_stream_index, timestamp, flags)) < 0) {
        printf("av_seek_frame errored\n");
      }
      return 0;
    }

    void destroy () {
      // av_free(streams_list);

      // avformat_close_input calls avformat_free_context itself
      avformat_close_input(&input_format_context);
      avio_context_free(&input_avio_context);
      
      avformat_free_context(output_format_context);
      avio_context_free(&output_avio_context);
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
    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }
    return buffer_size;
  }

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    auto& remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    // printf("WRITE FUNCTION SEEKING %d \n", remuxObject.seeking);
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
    if (remuxObject.frame_write_index >= 0) {
      remuxObject.frame_write_index = remuxObject.frame_write_index + 1;
    }

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
      .function("destroy", &Transmuxer::destroy)
      .function("seek", &Transmuxer::_seek)
      .function("getInfo", &Transmuxer::getInfo);
  }
}
