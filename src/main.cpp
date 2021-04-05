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

static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("readFunction %d | %s | %d \n", buf, buf, buf_size);
    auto& stream = *reinterpret_cast<std::istream*>(opaque);
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
}

// extern "C" {
  // std::stringstream* _initTransmux(char *buf, int length) {
  //   printf("initTransmux %d | %lu | %d | %d | %s \n", length, sizeof(buf), &buf, buf, buf);

  //   AVPacket packet;
  //   int fragmented_mp4_options = 0;

  //   std::stringstream stream;
  //   printf("debug1 %d \n", length);
  //   // try {
  //   stream.write(buf, length);
  //   // } catch (const std::exception& e) {
  //   //   printf("debug %s \n", &e);
  //   // }
  //   // printf("debug2 \n");

  //   unsigned char* buffer = (unsigned char*)av_malloc(5000000);
  //   AVIOContext* input_format_context = avio_alloc_context(
  //     buffer,
  //     5000000,
  //     0,
  //     reinterpret_cast<void*>(static_cast<std::istream*>(&stream)),
  //     &readFunction,
  //     nullptr,
  //     nullptr
  //   );
  //   printf("debug3 \n");
  //   AVFormatContext*output_format_context = NULL;

  //   AVFormatContext *formatContext = avformat_alloc_context();
  //   formatContext->pb = input_format_context;
  //   printf("debug4 \n");

  //   if (avformat_find_stream_info(formatContext, NULL) < 0) {
  //     printf("ERROR: could not get stream info \n");
  //   }

  //   printf("BEFORE \n");
  //   int res;
  //   if ((res = avformat_open_input(&formatContext, "", nullptr, nullptr)) < 0) {
  //     printf("ERROR: %s \n", av_err2str(res));
  //   }

  //   std::string name = formatContext->iformat->name;
  //   printf("AFTER %s \n", name.c_str());

  //   avformat_alloc_output_context2(&output_format_context, NULL, NULL, "");
  //   if(!output_format_context){
  //     fprintf(stderr,"Could not create output context\n");
  //   }

  //   int ret, i;
  //   int stream_index = 0;
  //   int *streams_list = NULL;
  //   int number_of_streams = 0;

  //   number_of_streams = formatContext->nb_streams;
  //   streams_list = (int*)av_mallocz_array(number_of_streams, sizeof(*streams_list));

  //   printf("number_of_streams %d %d \n", number_of_streams, streams_list);

  //   for (i = 0; i < formatContext->nb_streams; i++) {
  //     AVStream *out_stream;
  //     AVStream *in_stream = formatContext->streams[i];
  //     AVCodecParameters *in_codecpar = in_stream->codecpar;
  //     printf("in_codecpar->codec_type %d \n", in_codecpar->codec_type);
  //     if (
  //       in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
  //       in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO &&
  //       in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE
  //     ) {
  //       streams_list[i] = -1;
  //       continue;
  //     }
  //     streams_list[i] = stream_index++;
  //     out_stream = avformat_new_stream(output_format_context, NULL);
  //     if (!out_stream) {
  //       fprintf(stderr, "Failed allocating output stream\n");
  //       ret = AVERROR_UNKNOWN;
  //     }
  //     ret = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
  //     if (ret < 0) {
  //       fprintf(stderr, "Failed to copy codec parameters\n");
  //     }
  //   }

  //   AVDictionary* opts = NULL;

  //   if (fragmented_mp4_options) {
  //     // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
  //     av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);
  //   }

  //   // https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga18b7b10bb5b94c4842de18166bc677cb
  //   ret = avformat_write_header(output_format_context, &opts);
  //   if (ret < 0) {
  //     fprintf(stderr, "Error occurred when opening output file\n");
  //   }

  //   while (1) {
  //     AVStream *in_stream, *out_stream;
  //     ret = av_read_frame(formatContext, &packet);
  //     if (ret < 0)
  //       break;
  //     in_stream  = formatContext->streams[packet.stream_index];
  //     if (packet.stream_index >= number_of_streams || streams_list[packet.stream_index] < 0) {
  //       av_packet_unref(&packet);
  //       continue;
  //     }
  //     printf("PACKET %d | %d \n", packet.pts, packet.dts);
  //     packet.stream_index = streams_list[packet.stream_index];
  //     out_stream = output_format_context->streams[packet.stream_index];
  //     printf("PACKET 2 \n");
  //     /* copy packet */
  //     packet.pts = av_rescale_q_rnd(packet.pts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX));
  //     printf("PACKET 3 \n");
  //     packet.dts = av_rescale_q_rnd(packet.dts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX));
  //     printf("PACKET 4 \n");
  //     packet.duration = av_rescale_q(packet.duration, in_stream->time_base, out_stream->time_base);
  //     printf("PACKET 5 \n");
  //     // https://ffmpeg.org/doxygen/trunk/structAVPacket.html#ab5793d8195cf4789dfb3913b7a693903
  //     packet.pos = -1;
  //     printf("PACKET 6 \n");
  //     //https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga37352ed2c63493c38219d935e71db6c1
  //     ret = av_interleaved_write_frame(output_format_context, &packet);
  //     printf("PACKET 7 \n");
  //     if (ret < 0) {
  //       fprintf(stderr, "Error muxing packet\n");
  //       break;
  //     }
  //     av_packet_unref(&packet);
  //     printf("PACKET 8 \n");
  //   }

  //   printf("END \n");
  //   return &stream;
  // }

  // int cleanup () {
  //   avformat_close_input(&formatContext);
  //   av_free(input_format_context );
  // }

  // typedef struct RemuxObject {
  //   unsigned int pointer;
  //   unsigned int streamPointer;
  //   unsigned int formatContextPointer;
  // } RemuxObject;

//   RemuxObject initTransmux(std::string buf) {
//     printf("initTransmux %s  %d \n", buf.c_str(), buf.length());

//     std::stringstream stream;
//     stream.write(buf.c_str(), buf.length());

//     unsigned char* buffer = (unsigned char*)av_malloc(10000000);
//     AVIOContext* input_format_context = avio_alloc_context(
//       buffer,
//       1000000,
//       0,
//       reinterpret_cast<void*>(static_cast<std::istream*>(&stream)),
//       &readFunction,
//       nullptr,
//       nullptr
//     );
//     AVFormatContext*output_format_context = NULL;
//     AVFormatContext *formatContext = avformat_alloc_context();
//     formatContext->pb = input_format_context;

//     int res;
//     if ((res = avformat_find_stream_info(formatContext, NULL)) < 0) {
//       printf("ERROR: could not get stream info | %s \n", av_err2str(res));
//     }
//     if ((res = avformat_open_input(&formatContext, "", nullptr, nullptr)) < 0) {
//       printf("ERROR: %s \n", av_err2str(res));
//     }

//     std::string name = formatContext->iformat->name;
//     printf("video formats %s \n", name.c_str());

//     RemuxObject *responseBuffer = (RemuxObject*)av_malloc(sizeof(RemuxObject));

//     (*responseBuffer).streamPointer = reinterpret_cast<unsigned int>(&stream);
//     (*responseBuffer).formatContextPointer = reinterpret_cast<unsigned int>(&formatContext);
//     (*responseBuffer).pointer = *reinterpret_cast<unsigned int*>(&responseBuffer);

//     printf("response ptr test %#x %#x %#x %#x %#x \n", responseBuffer, (*responseBuffer).pointer, &responseBuffer, responseBuffer->pointer);
//     printf("stream ptr test %#x %#x %#x \n", &stream, (*responseBuffer).streamPointer, responseBuffer->streamPointer);

//     return *responseBuffer;
//   }
// }

// int test(unsigned int responsePointer, std::string buf) {
//   printf("test %d %#x %s  %d \n", responsePointer, responsePointer, buf.c_str(), buf.length());
//   struct RemuxObject *resPtr = (RemuxObject*)responsePointer;
//   printf("test response->stream %#x \n", (*resPtr).streamPointer);

//   std::stringstream *stream = (std::stringstream*)(*resPtr).streamPointer;
//   (*stream).write(buf.c_str(), buf.length());
//   printf("aaaaaa %p \n", stream);
//   return 1;
// }


// EMSCRIPTEN_BINDINGS(structs) {
//   emscripten::value_object<RemuxObject>("RemuxObject")
//     .field("pointer", &RemuxObject::pointer)
//     .field("streamPointer", &RemuxObject::streamPointer)
//     .field("formatContextPointer", &RemuxObject::formatContextPointer);

//   // emscripten::function("initTransmux", &initTransmux, emscripten::allow_raw_pointers());
//   emscripten::function("initTransmux", &initTransmux);
//   emscripten::function("test", &test);
// }

extern "C" {
  // class Remuxer {
  //   public:
  //     std::stringstream stream;
  //     AVIOContext* input_format_context;
  //     AVFormatContext* output_format_context;
  //     AVFormatContext *formatContext;

  //     Remuxer(std::string buf) :
  //       remuxer(buf) {
  //       stream.write(buf.c_str(), buf.length());

  //       unsigned char* buffer = (unsigned char*)av_malloc(10000000);

  //       input_format_context = avio_alloc_context(
  //         buffer,
  //         1000000,
  //         0,
  //         reinterpret_cast<void*>(static_cast<std::istream*>(&stream)),
  //         &readFunction,
  //         nullptr,
  //         nullptr
  //       );

  //       output_format_context = NULL;
  //       formatContext = avformat_alloc_context();
  //       formatContext->pb = input_format_context;
  //     }

  //     void push(std::string buf) {
  //       stream.write(buf.c_str(), buf.length());
  //     }
  // };

  // EMSCRIPTEN_BINDINGS(my_module) {
  //   class_<Remuxer>("Remuxer")
  //     .constructor<int>()
  //     .function("push", &Remuxer::push);
  // }



  class Remuxer {
  private:
    std::stringstream input_stream;
    std::stringstream output_stream;
    AVIOContext* input_format_context;
    AVFormatContext* output_format_context;
    AVFormatContext *formatContext;
    int ret, i;
    int stream_index;
    int *streams_list;
    int number_of_streams;
  public:
    Remuxer(std::string buf) {
      printf("init remuxer \n");

      formatContext = avformat_alloc_context();
      output_format_context = NULL;
      
      stream_index = 0;
      streams_list = NULL;
      number_of_streams = 0;

      input_stream.write(buf.c_str(), buf.length());

      unsigned char* buffer = (unsigned char*)av_malloc(10000000);
      input_format_context = avio_alloc_context(
        buffer,
        1000000,
        0,
        reinterpret_cast<void*>(static_cast<std::istream*>(&input_stream)),
        &readFunction,
        nullptr,
        nullptr
      );

      formatContext->pb = input_format_context;

      int res;
      if ((res = avformat_find_stream_info(formatContext, NULL)) < 0) {
        printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_open_input(&formatContext, "", nullptr, nullptr)) < 0) {
        printf("ERROR: %s \n", av_err2str(res));
        return;
      }
      avformat_alloc_output_context2(&output_format_context, NULL, NULL, "");

      number_of_streams = formatContext->nb_streams;
      streams_list = (int *)av_mallocz_array(number_of_streams, sizeof(*streams_list));

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        return;
      }

      for (i = 0; i < formatContext->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = formatContext->streams[i];
        AVCodecParameters *in_codecpar = in_stream->codecpar;
        if (in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
            in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO &&
            in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
          streams_list[i] = -1;
          continue;
        }
        streams_list[i] = stream_index++;
        out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          printf("Failed allocating output stream\n");
          res = AVERROR_UNKNOWN;
          return;
        }
        res = avcodec_parameters_copy(out_stream->codecpar, in_codecpar);
        if (res < 0) {
          printf("Failed to copy codec parameters\n");
          return;
        }
      }

      // unless it's a no file (we'll talk later about that) write to the disk (FLAG_WRITE)
      // but basically it's a way to save the file to a buffer so you can store it
      // wherever you want.
      if (!(output_format_context->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&output_format_context->pb, "", AVIO_FLAG_WRITE);
        if (ret < 0) {
          fprintf(stderr, "Could not open output file '%s'", "");
          return;
        }
      }
      AVDictionary* opts = NULL;

      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);



      // // https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga18b7b10bb5b94c4842de18166bc677cb
      // ret = avformat_write_header(output_format_context, &opts);
      // if (ret < 0) {
      //   fprintf(stderr, "Error occurred when opening output file\n");
      //   goto end;
      // }
      // while (1) {
      //   AVStream *in_stream, *out_stream;
      //   ret = av_read_frame(input_format_context, &packet);
      //   if (ret < 0)
      //     break;
      //   in_stream  = input_format_context->streams[packet.stream_index];
      //   if (packet.stream_index >= number_of_streams || streams_list[packet.stream_index] < 0) {
      //     av_packet_unref(&packet);
      //     continue;
      //   }
      //   packet.stream_index = streams_list[packet.stream_index];
      //   out_stream = output_format_context->streams[packet.stream_index];
      //   /* copy packet */
      //   packet.pts = av_rescale_q_rnd(packet.pts, in_stream->time_base, out_stream->time_base, AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX);
      //   packet.dts = av_rescale_q_rnd(packet.dts, in_stream->time_base, out_stream->time_base, AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX);
      //   packet.duration = av_rescale_q(packet.duration, in_stream->time_base, out_stream->time_base);
      //   // https://ffmpeg.org/doxygen/trunk/structAVPacket.html#ab5793d8195cf4789dfb3913b7a693903
      //   packet.pos = -1;

      //   //https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga37352ed2c63493c38219d935e71db6c1
      //   ret = av_interleaved_write_frame(output_format_context, &packet);
      //   if (ret < 0) {
      //     fprintf(stderr, "Error muxing packet\n");
      //     break;
      //   }
      //   av_packet_unref(&packet);
      // }
      // //https://ffmpeg.org/doxygen/trunk/group__lavf__encoding.html#ga7f14007e7dc8f481f054b21614dfec13
      // av_write_trailer(output_format_context);

    }

    std::string getInfo () {
      std::string name = formatContext->iformat->name;
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
