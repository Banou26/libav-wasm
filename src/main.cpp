#include <vector>
#include <string>
#include <vector>
#include <inttypes.h>
#include <iostream>
#include <sstream>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <algorithm>

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

  class Remuxer {
  public:
    AVIOContext* avioContext;
    AVIOContext* avioContext2;
    AVFormatContext* output_format_context;
    AVFormatContext* input_format_context;
    std::stringstream input_stream;
    std::stringstream output_stream;
    std::stringstream output_input_stream;
    int used_input;
    int written_output = 0;
    int used_output_input;
    int keyframe_index;
    int keyframe_pts;
    int keyframe_pos;
    int ret, i;
    int stream_index;
    int *streams_list;
    int number_of_streams;
    bool should_demux;
    int processed_bytes = 0;
    int input_length;
    int buffer_size;
    int video_stream_index;
    bool seeking;
    int64_t seeking_timestamp = -2;
    val read = val::undefined();
    val write = val::undefined();
    val seek = val::undefined();
    bool done = false;

    Remuxer(val options) {
      std::string hostStr = val::global("location")["host"].as<std::string>();
      const char* str = hostStr.c_str();
      std::string hostStdString(str);
      std::string sdbxAppHost("sdbx.app");
      std::string localhostProxyHost("localhost:2345");
      if (strcmp(str, "dev.fkn.app") != 0 && strcmp(str, "fkn.app") != 0 && !strstr(hostStdString.c_str(), sdbxAppHost.c_str()) && strcmp(str, "localhost:1234") != 0 && !strstr(hostStdString.c_str(), localhostProxyHost.c_str())) return;

      input_length = options["length"].as<int>();
      buffer_size = options["bufferSize"].as<int>();
      read = options["read"];
      write = options["write"];
      seek = options["seek"];
    }

    void init () {
      seeking = false;
      avioContext = NULL;
      input_format_context = avformat_alloc_context();
      output_format_context = avformat_alloc_context();

      should_demux = false;
      written_output = 0;
      stream_index = 0;
      streams_list = NULL;
      number_of_streams = 0;

      unsigned char* buffer = (unsigned char*)av_malloc(buffer_size);
      avioContext = avio_alloc_context(
        buffer,
        buffer_size,
        0,
        reinterpret_cast<void*>(this),
        &readFunction,
        nullptr,
        &seekFunction
      );

      input_format_context->pb = avioContext;

      int res;
      if ((res = avformat_open_input(&input_format_context, NULL, nullptr, nullptr)) < 0) {
        // printf("ERROR: %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        // printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }

      unsigned char* buffer2 = (unsigned char*)av_malloc(buffer_size);
      avioContext2 = avio_alloc_context(
        buffer2,
        buffer_size,
        1,
        reinterpret_cast<void*>(this),
        nullptr,
        &writeFunction,
        nullptr
      );

      avformat_alloc_output_context2(&output_format_context, NULL, "mp4", NULL);
      output_format_context->pb = avioContext2;

      number_of_streams = input_format_context->nb_streams;
      streams_list = (int *)av_mallocz_array(number_of_streams, sizeof(*streams_list));

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        // printf("No streams_list, %s \n", av_err2str(res));
        return;
      }

      for (i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVStream *out_in_stream;
        AVCodecParameters *in_codecpar = in_stream->codecpar;

        if (
          in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO
        ) {
          streams_list[i] = -1;
          continue;
        }

        if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          video_stream_index = i;
        }

        streams_list[i] = stream_index++;
        out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          // printf("Failed allocating output stream \n");
          res = AVERROR_UNKNOWN;
          return;
        }
        if ((res = avcodec_parameters_copy(out_stream->codecpar, in_codecpar)) < 0) {
          // printf("Failed to copy codec parameters \n");
          return;
        }
      }

      AVDictionary* opts = NULL;

      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      av_dict_set(&opts, "c", "copy", 0);
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

      // https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga18b7b10bb5b94c4842de18166bc677cb
      if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
        // printf("Error occurred when opening output file \n");
        return;
      }
    }

    void process(int size) {
      processed_bytes += size;
      // printf("process call, processed_bytes: %d, used_input: %d\n", processed_bytes, used_input);
      int res;
      AVPacket* packet = av_packet_alloc();
      AVFrame* pFrame;

      bool is_first_chunk = used_input == buffer_size;
      bool is_last_chunk = used_input + buffer_size >= input_length;
      bool output_input_init_done = false;
      int packetIndex = 0;
      AVStream *in_stream, *out_stream;

      while ((res = av_read_frame(input_format_context, packet)) >= 0) {
        if (packet->stream_index >= number_of_streams || streams_list[packet->stream_index] < 0) {
          av_packet_unref(packet);
          continue;
        }
        in_stream  = input_format_context->streams[packet->stream_index];
        out_stream = output_format_context->streams[packet->stream_index];

        if (out_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && packet->flags & AV_PKT_FLAG_KEY) {
          keyframe_index += 1;
          keyframe_pts = packet->pts;
          keyframe_pos = packet->pos;
        }
        if (input_length <= packet->pos) {
          break;
        }
        // todo: try using av_rescale_q(seek_target, AV_TIME_BASE_Q, pFormatCtx->streams[stream_index]->time_base)
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          break;
        }
        av_packet_unref(packet);
        if (!is_last_chunk && used_input + buffer_size > processed_bytes) {
          break;
        }
      }

      // if (res == AVERROR_EOF) {
      if (is_last_chunk && processed_bytes + buffer_size > processed_bytes) {
        keyframe_index -= 1;
        done = true;
        av_write_trailer(output_format_context);
      }
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

    void clearInput() {
      input_stream.clear();
      input_stream.str("");
      input_stream.seekp(0);
      input_stream.seekg(0);
    }

    void clearOutput() {
      output_stream.clear();
      output_stream.str("");
      output_stream.seekp(0);
      output_stream.seekg(0);
    }

    int _seek(int timestamp, int flags) {
      int res;
      if ((res = av_seek_frame(input_format_context, video_stream_index, timestamp, flags)) < 0) {
        printf("av_seek_frame errored\n");
      }
      AVPacket* packet = av_packet_alloc();
      res = av_read_frame(input_format_context, packet);
      char buf[1024];
      av_strerror(res, buf, sizeof(buf));
      printf("av_read_frame res %d %s \n", res, buf);
      av_packet_unref(packet);
      return 0;
    }

    void close () {
      // avformat_free_context(input_format_context);
      // avformat_free_context(output_format_context);
      // avio_close(avioContext);
      // avio_close(avioContext2);
    }

    void push(std::string buf) {
      input_stream.write(buf.c_str(), buf.length());
      processed_bytes += buf.length();
    }

    emscripten::val getInt8Array() {
      return emscripten::val(
        emscripten::typed_memory_view(
          output_stream.str().size(),
          output_stream.str().data()
        )
      );
    }
  };

  static int64_t seekFunction(void* opaque, int64_t offset, int whence) {
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    auto& seek = remuxObject.seek;
    auto result = seek((int)offset, whence).as<long>();
    // printf("seekFunction offset: %lld, flags: %d, result: %d\n", offset, whence, result);
    return result;
  }

  // todo: re-implement this when https://github.com/emscripten-core/emscripten/issues/16686 is fixed

  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    auto& read = remuxObject.read;
    val res = read(buf_size, remuxObject.used_input);
    std::string buffer = res["buffer"].as<std::string>();
    int buffer_size = res["size"].as<int>();
    remuxObject.used_input += buf_size;
    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);
    // printf("readFunction buf_size: %d, buffer_size: %d \n", buf_size, buffer_size);
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }
    return buffer_size;
  }

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    auto& write = remuxObject.write;
    // printf("writeFunction buf_size: %d \n", buf_size);
    write(
      static_cast<std::string>("data"),
      remuxObject.keyframe_index - 2,
      buf_size,
      remuxObject.written_output,
      emscripten::val(
        emscripten::typed_memory_view(
          buf_size,
          buf
        )
      ),
      remuxObject.keyframe_pts,
      remuxObject.keyframe_pos,
      remuxObject.done
    );
    remuxObject.written_output += buf_size;
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

    class_<Remuxer>("Remuxer")
      .constructor<emscripten::val>()
      .function("init", &Remuxer::init)
      .function("push", &Remuxer::push)
      .function("process", &Remuxer::process)
      .function("close", &Remuxer::close)
      .function("clearInput", &Remuxer::clearInput)
      .function("clearOutput", &Remuxer::clearOutput)
      .function("seek", &Remuxer::_seek)
      .function("getInfo", &Remuxer::getInfo)
      .function("getInt8Array", &Remuxer::getInt8Array);
  }
}
