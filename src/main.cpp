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

struct RemuxObject {
  std::stringstream* input_stream;
  std::stringstream* output_stream;
};

// static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
//     printf("readFunction %#x | %s | %d \n", buf, buf, buf_size);
//     auto& stream = *reinterpret_cast<std::istream*>(opaque);
//     stream.read(reinterpret_cast<char*>(buf), buf_size);
//     return stream.gcount();
// }

static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("readFunction %#x | %s | %d \n", buf, buf, buf_size);
    auto& remuxObject = *reinterpret_cast<RemuxObject*>(opaque);
    auto& stream = *reinterpret_cast<std::istream*>(remuxObject.input_stream);
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
}

static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("writeFunction %#x | %s | %d \n", buf, buf, buf_size);
    auto& remuxObject = *reinterpret_cast<RemuxObject*>(opaque);
    auto& stream = *reinterpret_cast<std::stringstream*>(remuxObject.output_stream);
    stream.write(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
}

// int write_packet (void *opaque, uint8_t *buf, int buf_size) {
//     IOOutput* out = reinterpret_cast<IOOutput*>(opaque);
//     memcpy(out->outBuffer+out->bytesSet, buf, buf_size);
//     out->bytesSet+=buf_size;
//     return buf_size;
// }

extern "C" {
  class Remuxer {
  private:
    std::stringstream input_stream;
    std::stringstream output_stream;
    AVIOContext* avioContext;
    AVIOContext* avioContext2;
    AVFormatContext* output_format_context;
    AVFormatContext* input_format_context;
    AVPacket packet;
    int ret, i;
    int stream_index;
    int *streams_list;
    int number_of_streams;

  public:
    Remuxer(std::string buf) {
      printf("init remuxer \n");

      input_format_context = avformat_alloc_context();
      
      avioContext = NULL;
      output_format_context = avformat_alloc_context();
      
      stream_index = 0;
      streams_list = NULL;
      number_of_streams = 0;
      size_t avio_ctx_buffer_size = 4096; // 100000000; // 4096;


      RemuxObject *remuxObject = (RemuxObject*)av_malloc(sizeof(RemuxObject));
      (*remuxObject).input_stream = &input_stream;
      (*remuxObject).output_stream = &output_stream;

      input_stream.write(buf.c_str(), buf.length());

      unsigned char* buffer = (unsigned char*)av_malloc(avio_ctx_buffer_size);
      avioContext = avio_alloc_context(
        buffer,
        avio_ctx_buffer_size,
        0,
        reinterpret_cast<void*>(remuxObject),
        // reinterpret_cast<void*>(static_cast<std::istream*>(&input_stream)),
        &readFunction,
        nullptr,
        nullptr
      );

      input_format_context->pb = avioContext;

      int res;
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_open_input(&input_format_context, NULL, nullptr, nullptr)) < 0) {
        printf("ERROR: %s \n", av_err2str(res));
        return;
      }

      // avformat_alloc_output_context2(&output_format_context, NULL, "mp4", NULL);
      // avformat_alloc_output_context2(&output_format_context, av_guess_format("mp4", NULL, "video/mp4"), NULL, NULL);

      unsigned char* buffer2 = (unsigned char*)av_malloc(avio_ctx_buffer_size);
      avioContext2 = avio_alloc_context(
        buffer2,
        avio_ctx_buffer_size,
        1,
        reinterpret_cast<void*>(remuxObject),
        // reinterpret_cast<void*>(static_cast<std::istream*>(&input_stream)),
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

      for (i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVCodecParameters *in_codecpar = in_stream->codecpar;
        printf("Codec type: %s \n", in_codecpar->codec_type);
        if (
          in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
            in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO // &&
            // in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE
        ) {
          streams_list[i] = -1;
          continue;
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


      // if (!(output_format_context->oformat->flags & AVFMT_NOFILE)) {
      //   res = avio_open(&output_format_context->pb, NULL, AVIO_FLAG_WRITE);
      //   if (res < 0) {
      //     printf("Could not open output file \n");
      //     return;
      //   }
      // }


      // if (res = avio_open(&output_format_context->pb, NULL, AVFMT_NOFILE) < 0) {
      //   printf("Could not open output file \n");
      //   return;
      // }
      printf("1 \n");
      AVDictionary* opts = NULL;

      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      // av_dict_set(&opts, "c", "copy", 0);
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);
      printf("2 \n");

      // https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga18b7b10bb5b94c4842de18166bc677cb

      // if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
      if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
        printf("Error occurred when opening output file \n");
        return;
      }
      printf("3 \n");
      while (1) {
        AVStream *in_stream, *out_stream;
        res = av_read_frame(input_format_context, &packet);
        printf("4 \n");
        if (res < 0)
          break;
        in_stream  = input_format_context->streams[packet.stream_index];
        if (packet.stream_index >= number_of_streams || streams_list[packet.stream_index] < 0) {
          av_packet_unref(&packet);
          continue;
        }
        printf("5 \n");
        packet.stream_index = streams_list[packet.stream_index];
        out_stream = output_format_context->streams[packet.stream_index];
        /* copy packet */
        packet.pts = av_rescale_q_rnd(packet.pts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX));
        packet.dts = av_rescale_q_rnd(packet.dts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX));
        packet.duration = av_rescale_q(packet.duration, in_stream->time_base, out_stream->time_base);
        // https://ffmpeg.org/doxygen/trunk/structAVPacket.html#ab5793d8195cf4789dfb3913b7a693903
        packet.pos = -1;
        printf("6 \n");

        //https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga37352ed2c63493c38219d935e71db6c1
        printf("7 \n");
        if ((res = av_interleaved_write_frame(output_format_context, &packet)) < 0) {
          printf("Error muxing packet \n");
          break;
        }
        printf("8 \n");
        av_packet_unref(&packet);
      }
      //https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga7f14007e7dc8f481f054b21614dfec13
      av_write_trailer(output_format_context);
    }

    std::string getInfo () {
      std::string name = input_format_context->iformat->name;
      return name.c_str();
    }

    void push(std::string buf) {
      input_stream.write(buf.c_str(), buf.length());
    }
  };

  // Binding code
  EMSCRIPTEN_BINDINGS(my_class_example) {
    class_<Remuxer>("Remuxer")
      .constructor<std::string>()
      .function("push", &Remuxer::push)
      .function("getInfo", &Remuxer::getInfo)
      ;
  }
}
