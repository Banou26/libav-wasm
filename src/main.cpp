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
    printf("readFunction %d | %s | %d \n", buf, buf, buf_size);
    auto& stream = *reinterpret_cast<std::istream*>(opaque);
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
}

extern "C" {
  std::stringstream* initTransmux(char *buf, int length) {
    printf("initTransmux %d | %lu | %d | %d | %s \n", length, sizeof(buf), &buf, buf, buf);

    std::stringstream stream;
    stream.write(buf, length);

    const std::shared_ptr<unsigned char> buffer(
      reinterpret_cast<unsigned char*>(av_malloc(5000000)),
      &av_free
    );

    const std::shared_ptr<AVIOContext> avioContext(
      avio_alloc_context(
        buffer.get(),
        5000000,
        0,
        reinterpret_cast<void*>(static_cast<std::istream*>(&stream)),
        &readFunction,
        nullptr,
        nullptr
      ),
      &av_free
    );

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
    printf("AFTER %s \n", name.c_str());
    
    return &stream;
  }

  int demux(std::stringstream *streamPtr, char *buf, int length) {
    auto stream = streamPtr;
    stream->write(buf, length);
    printf("demux %s \n", buf);
    return 1;
  }
}
