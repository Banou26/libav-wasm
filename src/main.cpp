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

  #include <libavutil/timestamp.h>
  #include <libavutil/mathematics.h>
  #include <libavutil/imgutils.h>
};

int main() {
  printf("Oz LibAV transmuxer init\n");
  return 0;
}

extern "C" {

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size);
  static int readFunction(void* opaque, uint8_t* buf, int buf_size);

  class Remuxer {
  private:
    AVIOContext* avioContext;
    AVIOContext* avioContext2;
    AVFormatContext* output_format_context;
    AVFormatContext* input_format_context;
    size_t avio_ctx_buffer_size;

    AVCodec* pCodec;
    AVCodecParameters* pCodecParameters;
    int video_stream_index;

    int ret, i;
    int stream_index;
    int *streams_list;
    int number_of_streams;
    bool should_decode;
    int input_size;

  public:
    std::stringstream input_stream;
    std::stringstream output_stream;
    int used_input;

    Remuxer() {}

    void init(int buffer_size) {
      printf("init remuxer \n");

      input_format_context = avformat_alloc_context();
      
      avioContext = NULL;
      output_format_context = avformat_alloc_context();

      should_decode = false;
      
      stream_index = 0;
      streams_list = NULL;
      number_of_streams = 0;
      avio_ctx_buffer_size = buffer_size; // 100000000; // 4096; // 8192;

      unsigned char* buffer = (unsigned char*)av_malloc(avio_ctx_buffer_size);
      avioContext = avio_alloc_context(
        buffer,
        avio_ctx_buffer_size,
        0,
        reinterpret_cast<void*>(this),
        &readFunction,
        nullptr,
        nullptr
      );

      input_format_context->pb = avioContext;

      int res;
      if ((res = avformat_open_input(&input_format_context, NULL, nullptr, nullptr)) < 0) {
        printf("ERROR: %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }

      unsigned char* buffer2 = (unsigned char*)av_malloc(avio_ctx_buffer_size);
      avioContext2 = avio_alloc_context(
        buffer2,
        avio_ctx_buffer_size,
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
        printf("No streams_list, %s \n", av_err2str(res));
        return;
      }

      pCodec = NULL;
      pCodecParameters = NULL;
      video_stream_index = -1;

      for (i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVCodecParameters *in_codecpar = in_stream->codecpar;
        printf("Codec type: %s \n", av_get_media_type_string(in_codecpar->codec_type));
        if (
          in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO // &&
          // in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE
        ) {
          streams_list[i] = -1;
          continue;
        }

        if (should_decode && in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          video_stream_index = i;
          pCodec = avcodec_find_decoder(in_codecpar->codec_id);
          pCodecParameters = in_codecpar;
        }

        streams_list[i] = stream_index++;
        out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          printf("Failed allocating output stream \n");
          res = AVERROR_UNKNOWN;
          return;
        }
        if ((res = avcodec_parameters_copy(out_stream->codecpar, in_codecpar)) < 0) {
          printf("Failed to copy codec parameters \n");
          return;
        }
      }

      AVDictionary* opts = NULL;

      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      av_dict_set(&opts, "c", "copy", 0);
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

      // https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga18b7b10bb5b94c4842de18166bc677cb
      if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
        printf("Error occurred when opening output file \n");
        return;
      }
    }

    void process() {
      int res;
      AVPacket* packet = av_packet_alloc();
      AVFrame* pFrame;
      AVCodecContext* pCodecContext;

      if (should_decode) {
        pFrame = av_frame_alloc();
        pCodecContext = avcodec_alloc_context3(pCodec);
        avcodec_parameters_to_context(pCodecContext, pCodecParameters);
        avcodec_open2(pCodecContext, pCodec, NULL);
      }

      printf("stream index %d/%d \n", used_input, input_size);
      while ((res = av_read_frame(input_format_context, packet)) >= 0) {
        if (packet->stream_index >= number_of_streams || streams_list[packet->stream_index] < 0) {
          av_packet_unref(packet);
          continue;
        }
        AVStream *in_stream, *out_stream;
        in_stream  = input_format_context->streams[packet->stream_index];
        out_stream = output_format_context->streams[packet->stream_index];

        if (should_decode && packet->stream_index == video_stream_index) {
          res = avcodec_send_packet(pCodecContext, packet);
          if (res == AVERROR(EAGAIN) || res == AVERROR_EOF) {
            continue;
          }
          res = avcodec_receive_frame(pCodecContext, pFrame);
          if (res == AVERROR(EAGAIN) || res == AVERROR_EOF) {
            continue;
          }

          if (pFrame->key_frame == 1) {
            printf("===\n");
            printf("KEYFRAME: true\n");
            printf("STREAM INDEX: %d \n", packet->stream_index);
            printf("PTS: %d \n", av_rescale_q_rnd(packet->pts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX)));
            printf("DTS: %d \n", av_rescale_q_rnd(packet->dts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX)));
            printf("POS: %d \n", packet->pos);
            printf("===\n");
          }
        }
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);

        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          printf("Error muxing packet \n");
          break;
        }
        av_packet_unref(packet);

        printf("stream index %d/%d \n", used_input, input_size);
        if (used_input + avio_ctx_buffer_size > input_size) {
          printf("STOPPED TRYING TO READ FRAMES AS THERE IS NOT ENOUGH DATA ANYMORE %d/%d \n", used_input, input_size);
          break;
        }
      }
    }

    std::string getInfo () {
      std::string name = input_format_context->iformat->name;
      return name.c_str();
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

    void close () {
      av_write_trailer(output_format_context);
    }

    void push(std::string buf) {
      input_stream.write(buf.c_str(), buf.length());
      input_size += buf.length();
    }

    emscripten::val getInt8Array() {
      printf("get remuxed result %s \n", output_stream.str().data());
      return emscripten::val(
        emscripten::typed_memory_view(
          output_stream.str().size(),
          output_stream.str().data()
        )
      );
    }
  };

  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("readFunction %#x | %s | %d \n", buf, buf, buf_size);
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    remuxObject.used_input += buf_size;
    auto& stream = remuxObject.input_stream;
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
  }

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("writeFunction %#x | %s | %d \n", buf, buf, buf_size);
    // printf("writeFunction %#x | %s | %d \n", buf, &buf, buf_size);
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    auto& stream = remuxObject.output_stream;
    stream.write(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
  }

  // Binding code
  EMSCRIPTEN_BINDINGS(my_class_example) {
    class_<Remuxer>("Remuxer")
      .constructor<>()
      .function("init", &Remuxer::init)
      .function("push", &Remuxer::push)
      .function("process", &Remuxer::process)
      .function("close", &Remuxer::close)
      .function("clearInput", &Remuxer::clearInput)
      .function("clearOutput", &Remuxer::clearOutput)
      .function("getInfo", &Remuxer::getInfo)
      .function("getInt8Array", &Remuxer::getInt8Array)
      ;
  }
}
