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

// static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
//     // printf("readFunction\n");
//     printf("readFunction %d %s %d \n", buf, buf, buf_size);
//     auto& stream = *reinterpret_cast<std::istream*>(opaque);
//     stream.read(reinterpret_cast<char*>(buf), buf_size);
//     // avformat_close_input();
//     return stream.gcount();
// }

// static int readFunction1(void* opaque, uint8_t* buf, int buf_size){
//    //Cast the opaque pointer to std::stringstream
//    std::stringstream * me =static_cast<std::stringstream *>(opaque);

//    //If we are at the end of the stream return FFmpeg's EOF
//    if(me->tellg() == buf_size){
//      return AVERROR_EOF;
//    }
//    // Read the stream into the buf and cast it to char *
//    me->read((char*)buf, buf_size);

//    //return how many characters extracted
//    return me->tellg();
// }

// static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
//   printf("readFunction %d %s %d \n", buf, buf, buf_size);
//   auto& stream = *reinterpret_cast<std::istream*>(opaque);
//   stream.read(reinterpret_cast<char*>(buf), buf_size);
//   return stream.gcount();
// }

// static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
//   printf("readFunction %d %s %d \n", buf, buf, buf_size);
//   auto& stream = *reinterpret_cast<std::istream*>(opaque);
//   try
//   {
//     stream.read(reinterpret_cast<char*>(buf), buf_size);
//   }
//   catch(const std::exception& e)
//   {
      
//   }
//   printf("readFunctionEnd %d \n", stream.gcount());
//   return stream.gcount();
// }

extern "C" {
  int initTransmux(char *buf, int length) {
    // printf("initTransmux\n");
    printf("initTransmux %d %lu %d %d %s\n", length, sizeof(buf), &buf, buf, buf);

    int ret = 0;
    for (int i = 0; i < length; ++i)
    {
      printf("byte %d\n", *(buf + ret));
    }

    std::stringstream stream;
    
    stream.write((char const*) &buf, sizeof(buf));

    printf("initTransmux %s\n", stream.read(reinterpret_cast<char*>(&n), sizeof n));
    // printf("initTransmux %s\n", stream.read(reinterpret_cast<char*>(buf), length));


    // const std::shared_ptr<unsigned char> buffer(reinterpret_cast<unsigned char*>(av_malloc(5000000)), &av_free);
    // const std::shared_ptr<AVIOContext> avioContext(avio_alloc_context(buffer.get(), 5000000, 0, reinterpret_cast<void*>(static_cast<std::istream*>(&stream)), &readFunction, nullptr, nullptr), &av_free);

    // const auto avFormat = std::shared_ptr<AVFormatContext>(avformat_alloc_context(), &avformat_free_context);
    // auto avFormatPtr = avFormat.get();
    // avFormat->pb = avioContext.get();
    // av_free(avioContext->buffer);
    // if (avformat_find_stream_info(avFormatPtr, NULL) < 0) {
    //   printf("ERROR: could not get stream info \n");
    // }
    // printf("FFFFFFFFFFFF \n");

    // int res;
    // if ((res = avformat_open_input(&avFormatPtr, "", nullptr, nullptr)) < 0) {
    //   printf("ERROR: %s \n", av_err2str(res));
    // }

    // printf("AAAAAAAAAA \n");

    // std::string name = avFormat->iformat->name;


    return 1;
  }

  int push(char *buf) {
    printf("demux %s\n", buf);
    AVOutputFormat *ofmt_a = NULL,*ofmt_v = NULL;
    AVFormatContext *pFormatContext = avformat_alloc_context();
    AVPacket pkt;
    return 1;
  }

  int demux(char *buf) {
    printf("demux %s\n", buf);
    AVOutputFormat *ofmt_a = NULL,*ofmt_v = NULL;
    AVFormatContext *pFormatContext = avformat_alloc_context();
    AVPacket pkt;
    return 1;
  }
}
