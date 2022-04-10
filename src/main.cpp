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
  int duration;
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
  private:
    AVIOContext* avioContext;
    AVIOContext* avioContext2;
    AVFormatContext* output_format_context;
    AVFormatContext* input_format_context;

  public:
    std::stringstream input_stream;
    std::stringstream output_stream;
    std::stringstream output_input_stream;
    int used_input;
    int written_output = 0;
    int used_output_input;
    val callback = val::undefined();
    int keyframe_index;
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
    int64_t seeking_timestamp;
    val read = val::undefined();

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
      callback = options["callback"];
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
      printf("process call, processed_bytes: %d, used_input: %d\n", processed_bytes, used_input);
      int res;
      AVPacket* packet = av_packet_alloc();
      AVFrame* pFrame;
      AVCodecContext* pCodecContext;

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
        }

        // todo: try using av_rescale_q(seek_target, AV_TIME_BASE_Q, pFormatCtx->streams[stream_index]->time_base)

        // todo: check if https://stackoverflow.com/questions/64547604/libavformat-ffmpeg-muxing-into-mp4-with-avformatcontext-drops-the-final-frame could help with the last frames
        // packet->pos = -1;
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

        if (input_length <= packet->pos) {
          break;
        }
        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          break;
        }
        av_packet_unref(packet);

        if (!is_last_chunk && used_input + buffer_size > processed_bytes) {
          break;
        }
      }

      char buf[1024];
      av_strerror(res, buf, sizeof(buf));
      printf("av_read_frame res %d %s \n", res, buf);

      if (is_last_chunk && processed_bytes + buffer_size > processed_bytes) {
        keyframe_index -= 1;
        av_write_trailer(output_format_context);
        // av_packet_free(&packet);
        // avformat_free_context(input_format_context);
        // avformat_free_context(output_format_context);
        // avio_close(avioContext);
        // avio_close(avioContext2);
      }
    }

    InfoObject getInfo () {
      return {
        .input = {
          .formatName = input_format_context->iformat->name,
          .mimeType = input_format_context->iformat->mime_type,
          .duration = (int)input_format_context->duration
        },
        .output = {
          .formatName = output_format_context->oformat->name,
          .mimeType = output_format_context->oformat->mime_type,
          .duration = (int)output_format_context->duration
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

    int seek(int timestamp, int _flags) {
      printf("seek %d %lld %d \n", timestamp, (int64_t)(timestamp), _flags);
      // https://ffmpeg.org/doxygen/trunk/group__lavf__decoding.html#gaa03a82c5fd4fe3af312d229ca94cd6f3
      avio_flush(input_format_context->pb);
      avformat_flush(input_format_context);
      avio_flush(output_format_context->pb);
      avformat_flush(output_format_context);
      int flags = AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE;
      int64_t offset = 5000000;
      printf("av_seek_frame ???????? %d %lld %d \n", video_stream_index, offset, flags);
      seeking = true;
      seeking_timestamp = (int64_t)timestamp;
      used_input = (int)seeking_timestamp;
      processed_bytes = (int)seeking_timestamp;
      int res;
      // if ((res = avio_seek(input_format_context->pb, seeking_timestamp, 0)) < 0) {
      // // if ((res = av_seek_frame(input_format_context, video_stream_index, (int64_t)timestamp, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
      //   printf("avio_seek errored\n");
      // }
      // printf("avio_seek res %d \n", res);

      if ((res = av_seek_frame(input_format_context, video_stream_index, offset, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
      // if ((res = av_seek_frame(input_format_context, video_stream_index, (int64_t)timestamp, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
        printf("av_seek_frame errored\n");
      }

      // if ((res = av_seek_frame(input_format_context, -1, offset, 0)) < 0) {
      // // if ((res = av_seek_frame(input_format_context, video_stream_index, (int64_t)timestamp, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
      //   printf("av_seek_frame errored\n");
      // }

      // if ((res = av_seek_frame(input_format_context, -1, offset, AVSEEK_FLAG_BYTE)) < 0) {
      // // if ((res = av_seek_frame(input_format_context, video_stream_index, (int64_t)timestamp, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
      //   printf("av_seek_frame errored\n");
      // }

      // if ((res = av_seek_frame(input_format_context, -1, offset, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
      // // if ((res = av_seek_frame(input_format_context, video_stream_index, (int64_t)timestamp, AVSEEK_FLAG_BACKWARD & AVSEEK_FLAG_BYTE)) < 0) {
      //   printf("av_seek_frame errored\n");
      // }

      printf("av_seek_frame res %d \n", res);
      seeking = false;

      return 0;
      // int res = av_seek_frame(input_format_context, video_stream_index, (int64_t)(timestamp), AVSEEK_FLAG_BYTE);
      // seeking = true;
      // return res;
      // return av_seek_frame(input_format_context, -1, timestamp, flags);
      // return 0;
    }

    void close () {
      // av_write_trailer(output_format_context);
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
    printf("seekFunction %d | %d, isSeeking: %d \n", offset, whence, remuxObject.seeking);
    if (remuxObject.seeking) {
      printf("seekFunction INNNNNNN %d | %d, isSeeking: %d, seekingTimestamp: %lld \n", offset, whence, remuxObject.seeking, remuxObject.seeking_timestamp);
      // remuxObject.seeking = false;
      // return offset;
      // return remuxObject.seeking_timestamp;
      // return 0;
      return offset;
    }
    return -1;
  }

  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("readFunction %#x | %s | %d \n", buf, &buf, buf_size);
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    auto& read = remuxObject.read;

    // todo: re-implement this when https://github.com/emscripten-core/emscripten/issues/16686 is fixed
    // val resPromise = read(remuxObject.used_input);
    // val res = resPromise.await();
    // printf("res %d \n", read().await().as<int>());

    val res = read(remuxObject.used_input);
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
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    auto& callback = remuxObject.callback;
    callback(
      static_cast<std::string>("data"),
      remuxObject.keyframe_index - 2,
      buf_size,
      remuxObject.written_output,
      emscripten::val(
        emscripten::typed_memory_view(
          buf_size,
          buf
        )
      )
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
      .function("seek", &Remuxer::seek)
      .function("getInfo", &Remuxer::getInfo)
      .function("getInt8Array", &Remuxer::getInt8Array)
      ;
  }
}
