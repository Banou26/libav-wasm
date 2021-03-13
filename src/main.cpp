#include <vector>
#include <string>
#include <vector>
#include <inttypes.h>
#include <iostream>
#include <sstream>
#include <emscripten.h>
#include <emscripten/bind.h>

extern "C" {
  #include <libavcodec/avcodec.h>
  #include <libavformat/avformat.h>
  #include <libavutil/avutil.h>
  #include <libavutil/imgutils.h>
};

int main() {
  printf("Oz LibAV transmuxer init\n");
  return 0;
}

static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    // printf("readFunction\n");
    printf("readFunction %d | %s | %d \n", buf, buf, buf_size);
    auto& stream = *reinterpret_cast<std::istream*>(opaque);
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    emscripten_sleep(1000);
    // avformat_close_input();
    return stream.gcount();
}

extern "C" {
  std::stringstream* initTransmux(char *buf, int length) {
    printf("initTransmux %d | %lu | %d | %d | %s\n", length, sizeof(buf), &buf, buf, buf);

    auto str = "Enter the name of an existing text file: ";

    std::stringstream stream;
    stream.write(buf, length);

    // char c;
    // while (stream.get(c)) {
    //   printf("read %c\n", c);
    // }

    const std::shared_ptr<unsigned char> buffer(reinterpret_cast<unsigned char*>(av_malloc(5000000)), &av_free);
    const std::shared_ptr<AVIOContext> avioContext(avio_alloc_context(buffer.get(), 5000000, 0, reinterpret_cast<void*>(static_cast<std::istream*>(&stream)), &readFunction, nullptr, nullptr), &av_free);

    const auto avFormat = std::shared_ptr<AVFormatContext>(avformat_alloc_context(), &avformat_free_context);
    auto avFormatPtr = avFormat.get();
    avFormat->pb = avioContext.get();
    av_free(avioContext->buffer);
    if (avformat_find_stream_info(avFormatPtr, NULL) < 0) {
      printf("ERROR: could not get stream info \n");
    }

    printf("BEFORE \n");
    int res;
    if ((res = avformat_open_input(&avFormatPtr, "", nullptr, nullptr)) < 0) {
      printf("ERROR: %s \n", av_err2str(res));
    }
    std::string name = avFormat->iformat->name;
    printf("AFTER %s\n", name.c_str());
    return &stream;
  }

  // int initTransmux(char *buf, int length) {
  //   printf("initTransmux %d %lu %d %d %s\n", length, sizeof(buf), &buf, buf, buf);

  //   auto str = "Enter the name of an existing text file: ";

  //   std::stringstream stream;
  //   stream.write(buf, length);

  //   // char c;
  //   // while (stream.get(c)) {
  //   //   printf("read %c\n", c);
  //   // }

  //   AVFormatContext *pFormatContext = avformat_alloc_context();
  //   avformat_open_input(&pFormatContext, "", NULL, NULL);

  //   if (avformat_find_stream_info(pFormatContext, NULL) < 0) {
  //     printf("ERROR: could not get stream info \n");
  //   }

  //   printf("BEFORE \n");
  //   int res;
  //   if ((res = avformat_open_input(&pFormatContext, "", nullptr, nullptr)) < 0) {
  //     printf("ERROR: %s \n", av_err2str(res));
  //   }
  //   std::string name = pFormatContext->iformat->name;

  //   printf("AFTER %s\n", name.c_str());

  //   return 1;
  // }

  // int initTransmux(char *buf, int length) {
  //     stringstream stream(ios::in|ios::out);
  //     std::string dat("This is a test string to send");

  //     stream.str(dat);
  //     printf("read %s\n", stream.str().c_str());

  //     stream.str("");
  //     printf("read %s\n", stream.str().c_str());

  //     return 0;
  // }

  int demux(std::stringstream *streamPtr, char *buf, int length) {
    auto stream = streamPtr;
    stream->write(buf, length);
    printf("demux %s\n", buf);
    return 1;
  }

  // int demux(char *buf) {
  //   auto stream = streamPtr;
  //   // auto& stream = *reinterpret_cast<std::istream*>(streamPtr);
  //   // auto& stream = reinterpret_cast<void*>(static_cast<std::istream*>(&streamPtr));
  //   stream->write(buf, length);
  //   printf("demux %s\n", buf);
  //   AVOutputFormat *ofmt_a = NULL,*ofmt_v = NULL;
  //   AVFormatContext *pFormatContext = avformat_alloc_context();
  //   AVPacket pkt;
  //   return 1;
  // }
}
