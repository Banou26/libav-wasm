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

EM_JS(const char*, getValue, (const char* s, const char* s2), {
  var r =
    UTF8ToString(s)
      .split(UTF8ToString(s2))
      .reduce(
        (v, c) => v && v[c],
        globalThis
      );
  var l = lengthBytesUTF8(r)+1;
  var rs = _malloc(l);
  stringToUTF8(r, rs, l);
  return rs;
});

int main() {
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
    AVIOContext* avioContext3;
    AVFormatContext* output_format_context;
    AVFormatContext* output_input_format_context;
    AVFormatContext* input_format_context;
    size_t avio_ctx_buffer_size;

    AVCodec* pCodec;
    // AVCodec* subtitleCodec;
    // AVCodecParameters* subtitleCodecParameters;
    AVCodecParameters* pCodecParameters;
    int video_stream_index;

    int ret, i;
    int stream_index;
    int *streams_list;
    int number_of_streams;
    bool should_decode;
    bool should_demux;
    int processed_bytes;
    int input_size;
    int buffer_size;
    uint64_t previous_packet_pts;

  public:
    std::stringstream input_stream;
    std::stringstream output_stream;
    std::stringstream output_input_stream;
    int used_input;
    int written_output = 0;
    int used_output_input;
    val callback = val::undefined();
    int keyframe_index;
    double keyframe_start_time;
    double keyframe_end_time;

    Remuxer(int _input_size) {
      input_size = _input_size;
    }

    void init(int _buffer_size, val cb) {
      callback = cb;
      buffer_size = _buffer_size;
      const char* str = getValue("location.host", ".");
      std::string hostStdString(str);
      std::string sdbxAppHost("sdbx.app");
      std::string localhostProxyHost("localhost:2345");
      if (strcmp(str, "dev.fkn.app") != 0 && strcmp(str, "fkn.app") != 0 && !strstr(hostStdString.c_str(), sdbxAppHost.c_str()) && strcmp(str, "localhost:1234") != 0 && !strstr(hostStdString.c_str(), localhostProxyHost.c_str())) return;
      free(&str);
      input_format_context = avformat_alloc_context();
      
      avioContext = NULL;
      output_format_context = avformat_alloc_context();

      should_decode = false;
      should_demux = false;
      written_output = 0;
      stream_index = 0;
      streams_list = NULL;
      number_of_streams = 0;
      avio_ctx_buffer_size = _buffer_size; // 100000000; // 4096; // 8192;

      unsigned char* buffer = (unsigned char*)av_malloc(avio_ctx_buffer_size);
      avioContext = avio_alloc_context(
        buffer,
        avio_ctx_buffer_size,
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

      if (should_demux) {
        output_input_format_context = avformat_alloc_context();
        avioContext3 = avio_alloc_context(
          buffer2,
          avio_ctx_buffer_size,
          0,
          reinterpret_cast<void*>(this),
          &readOutputFunction,
          nullptr,
          nullptr
        );

        output_input_format_context->pb = avioContext3;

        // if ((res = avformat_open_input(&output_input_format_context, NULL, nullptr, nullptr)) < 0) {
        //   // printf("ERROR: %s \n", av_err2str(res));
        //   return;
        // }
        // if ((res = avformat_find_stream_info(output_input_format_context, NULL)) < 0) {
        //   // printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        //   return;
        // }
      }

      number_of_streams = input_format_context->nb_streams;
      streams_list = (int *)av_mallocz_array(number_of_streams, sizeof(*streams_list));

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        // printf("No streams_list, %s \n", av_err2str(res));
        return;
      }

      pCodec = NULL;
      // subtitleCodec = NULL;
      pCodecParameters = NULL;
      // subtitleCodecParameters = NULL;
      video_stream_index = -1;

      for (i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVStream *out_in_stream;
        AVCodecParameters *in_codecpar = in_stream->codecpar;
        // printf("Codec type: %s \n", av_get_media_type_string(in_codecpar->codec_type));

        // if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        //   streams_list[i] = -1;
        //   subtitleCodec = avcodec_find_decoder(in_codecpar->codec_id);
        //   subtitleCodecParameters = in_codecpar;
        //   continue;
        // }

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
        out_in_stream = avformat_new_stream(output_input_format_context, NULL);
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

    static void log_packet(const AVFormatContext *fmt_ctx, const AVPacket *pkt, const char *tag)
    {
        AVRational *time_base = &fmt_ctx->streams[pkt->stream_index]->time_base;
    
        printf("%s: pts:%s pts_time:%s dts:%s dts_time:%s duration:%s duration_time:%s stream_index:%d\n",
              tag,
              av_ts2str(pkt->pts), av_ts2timestr(pkt->pts, time_base),
              av_ts2str(pkt->dts), av_ts2timestr(pkt->dts, time_base),
              av_ts2str(pkt->duration), av_ts2timestr(pkt->duration, time_base),
              pkt->stream_index);
    }

    void process() {
      int res;
      AVPacket* packet = av_packet_alloc();
      AVFrame* pFrame;
      AVCodecContext* pCodecContext;
      // AVCodecContext* subtitleCodecContext;

      if (should_decode) {
        pFrame = av_frame_alloc();
        pCodecContext = avcodec_alloc_context3(pCodec);
        avcodec_parameters_to_context(pCodecContext, pCodecParameters);
        avcodec_open2(pCodecContext, pCodec, NULL);
      }
      // else {
      //   printf("codec name subtitle %s\n", subtitleCodec->long_name);
      //   subtitleCodecContext = avcodec_alloc_context3(subtitleCodec);
      //   avcodec_parameters_to_context(subtitleCodecContext, subtitleCodecParameters);
      //   avcodec_open2(subtitleCodecContext, subtitleCodec, NULL);
      // }

      // av_dump_format(input_format_context, 0, "", 1);
      // av_dump_format(output_format_context, 0, "", 1);

      bool is_first_chunk = used_input == buffer_size;
      bool is_last_chunk = used_input + avio_ctx_buffer_size >= input_size;
      bool output_input_init_done = false;
      int packetIndex = 0;

      // int got_sub;
      // AVSubtitle* subtitle;
      // AVSubtitleRect** rects;
      // AVSubtitleRect* rect;
      // AVStream *subtitle_stream  = input_format_context->streams[packet->stream_index];
      AVStream *in_stream, *out_stream;

      while ((res = av_read_frame(input_format_context, packet)) >= 0) {
        // if (input_format_context->streams[packet->stream_index]->codec->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        // if (input_format_context->streams[packet->stream_index]->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
        //   subtitle_stream = input_format_context->streams[packet->stream_index];
        //   res = avcodec_send_packet(pCodecContext, packet);
        //   if (res == AVERROR(EAGAIN) || res == AVERROR_EOF) {
        //     continue;
        //   }
        //   if ((res = avcodec_decode_subtitle2(pCodecContext, subtitle, &got_sub, packet)) < 0) {
        //     printf("Error decoding subtitle %s \n", av_err2str(res));
        //     break;
        //   }
        //   rects = subtitle->rects;
        //   for (i = 0; i < subtitle->num_rects; i++) {
        //     rect = rects[i];
        //     if (rect->type == SUBTITLE_ASS) {
        //       printf("%s \n", rect->ass);
        //     } else if (rect->type == SUBTITLE_TEXT) {
        //       printf("%s \n", rect->text);
        //     }
        //   }
        //   continue;
        // }
        if (packet->stream_index >= number_of_streams || streams_list[packet->stream_index] < 0) {
          av_packet_unref(packet);
          continue;
        }
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
            // printf("===\n");
            // printf("KEYFRAME: true\n");
            // printf("STREAM INDEX: %d \n", packet->stream_index);
            // printf("PTS: %d \n", av_rescale_q_rnd(packet->pts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX)));
            // printf("DTS: %d \n", av_rescale_q_rnd(packet->dts, in_stream->time_base, out_stream->time_base, (AVRounding)(AV_ROUND_NEAR_INF|AV_ROUND_PASS_MINMAX)));
            // printf("POS: %d \n", packet->pos);
            // printf("===\n");
          }
        }

        
        // printf("in index entry [%d] timestamp offset: %lld, timestamp: %lld \n", i, in_stream->mux_ts_offset, in_stream->index_entries[0].timestamp);
        // printf("out index entry [%d] timestamp offset: %lld, timestamp: %lld \n", i, out_stream->mux_ts_offset, out_stream->index_entries[0].timestamp);

        // int i;
        // for (i = 0; i < in_stream->nb_index_entries; i++) {
        //   printf("index entry [%d] timestamp: %lld \n", i, in_stream->index_entries[i].timestamp);
        // }
        
        // printf("index entries: %d \n", in_stream->index_entries);
        // printf("PTS before: %#x \n", packet->flags);
        // if (packet->flags & AV_PKT_FLAG_KEY) {
        //   printf("PTS before: %d \n", packet->pts);
        // }

        if (out_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && packet->flags & AV_PKT_FLAG_KEY) {
          // callback(keyframe_index - 1);
          if (previous_packet_pts != -1) {
            printf("packet %d end at %f\n", keyframe_index - 1, static_cast<double>(previous_packet_pts) / in_stream->time_base.den);
            keyframe_end_time = static_cast<double>(previous_packet_pts) / in_stream->time_base.den;
          }
          // printf("before packet in start: %f \n", static_cast<double>(in_stream->start_time));
          // log_packet(input_format_context, packet, "in");
          keyframe_start_time = static_cast<double>(packet->pts) / in_stream->time_base.den;
          printf("packet %d start at %f, size: %d, %d, %lld\n", keyframe_index, static_cast<double>(packet->pts) / in_stream->time_base.den, packet->size, packet->buf->size, packet->pos);
          // printf("before packet in start: %f,  pts: %lld, dts: %lld, pos: %lld, size: %d \n", static_cast<double>(packet->pts) / in_stream->time_base.den, packet->pts, packet->dts, packet->pos, packet->size);
          // printf("before packet out start: %f,  pts: %lld, dts: %lld, pos: %lld, size: %d \n", static_cast<double>(packet->pts) / in_stream->time_base.den, packet->pts, packet->dts, packet->pos, packet->size);
          keyframe_index = keyframe_index + 1;
        }


        previous_packet_pts = packet->pts;

        // int currentPacketIndex = packetIndex;
        // packetIndex = packetIndex + 1;

        // if (in_stream-> == currentPacketIndex) {
        //   printf("packet currentPacketIndex %d %d \n", currentPacketIndex, in_stream->nb_index_entries);
        //   packetIndex = 0;
        // }

        // todo: check if https://stackoverflow.com/questions/64547604/libavformat-ffmpeg-muxing-into-mp4-with-avformatcontext-drops-the-final-frame could help with the last frames
        packet->pos = -1;
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
        // if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
        //   // printf("after packet start_time: %lld, time_base: %d, pts: %lld, dts: %lld, pos: %lld, size: %d \n", in_stream->cur_dts, in_stream->, packet->den, packet->dts, packet->pos, packet->size);
        // }
        // if (packet->flags & AV_PKT_FLAG_KEY) {
        //   printf("PTS before: %d \n", packet->pts);
        // }

        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          // printf("Error muxing packet \n");
          break;
        }

        av_packet_unref(packet);

        if (should_demux) {
          printf("FIRST CHUNKKKKKKKKKK %d \n", keyframe_index);
          if (is_first_chunk && keyframe_index == 0 && !output_input_init_done) {
            printf("FIRST CHUNKKKKKKKKKK \n");
            if ((res = avformat_open_input(&output_input_format_context, NULL, nullptr, nullptr)) < 0) {
              // printf("ERROR: %s \n", av_err2str(res));
              return;
            }
            if ((res = avformat_find_stream_info(output_input_format_context, NULL)) < 0) {
              // printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
              return;
            }
            output_input_init_done = true;
          }

          if (!is_first_chunk) {

            printf("try readframe \n");

            if ((res = av_read_frame(output_input_format_context, packet)) < 0) {
              printf("ERROR: av_read_frame(output_input_format_context, packet) | %s \n", av_err2str(res));
              return;
            }
            printf("try readframe done \n");

            out_stream = output_input_format_context->streams[packet->stream_index];

            if (out_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && packet->flags & AV_PKT_FLAG_KEY) {
              // if (previous_packet_pts != -1) {
              //   printf("packet %d end at %f\n", keyframe_index - 1, static_cast<double>(previous_packet_pts) / in_stream->time_base.den);
              // }
              // printf("before packet in start: %f \n", static_cast<double>(in_stream->start_time));
              // log_packet(input_format_context, packet, "in");
              printf("packet start at %f, size: %d, %d, %lld\n", static_cast<double>(packet->pts) / out_stream->time_base.den, packet->size, packet->buf->size, packet->pos);
              // printf("before packet in start: %f,  pts: %lld, dts: %lld, pos: %lld, size: %d \n", static_cast<double>(packet->pts) / in_stream->time_base.den, packet->pts, packet->dts, packet->pos, packet->size);
              // printf("before packet out start: %f,  pts: %lld, dts: %lld, pos: %lld, size: %d \n", static_cast<double>(packet->pts) / in_stream->time_base.den, packet->pts, packet->dts, packet->pos, packet->size);
              // keyframe_index = keyframe_index + 1;
            }

            av_packet_unref(packet);
          }
        }

        if (!is_last_chunk && used_input + avio_ctx_buffer_size > processed_bytes) {
          // printf("STOPPED TRYING TO READ FRAMES AS THERE IS NOT ENOUGH DATA ANYMORE %d/%d:%d \n", used_input, processed_bytes, input_size);
          break;
        }
      }

      // printf("FIRST CHUNKKKKKKKKKK %d %d %d %d \n", is_first_chunk, used_input, input_size, buffer_size);

      // if (is_first_chunk && keyframe_index - 1 == 0) {
      //   printf("FIRST CHUNKKKKKKKKKK \n");
      //   if ((res = avformat_open_input(&output_input_format_context, NULL, nullptr, nullptr)) < 0) {
      //     // printf("ERROR: %s \n", av_err2str(res));
      //     return;
      //   }
      //   if ((res = avformat_find_stream_info(output_input_format_context, NULL)) < 0) {
      //     // printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
      //     return;
      //   }
      // }

      if (should_demux) {
        printf("should demux\n");
        if (is_first_chunk) {
          while ((res = av_read_frame(output_input_format_context, packet)) >= 0) {
            printf("OUT packet start\n");
            out_stream = output_input_format_context->streams[packet->stream_index];

            if (out_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && packet->flags & AV_PKT_FLAG_KEY) {
              // if (previous_packet_pts != -1) {
              //   printf("packet %d end at %f\n", keyframe_index - 1, static_cast<double>(previous_packet_pts) / in_stream->time_base.den);
              // }
              // printf("before packet in start: %f \n", static_cast<double>(in_stream->start_time));
              // log_packet(input_format_context, packet, "in");
              printf("packet start at %f, size: %d, %d, %lld\n", static_cast<double>(packet->pts) / out_stream->time_base.den, packet->size, packet->buf->size, packet->pos);
              // printf("before packet in start: %f,  pts: %lld, dts: %lld, pos: %lld, size: %d \n", static_cast<double>(packet->pts) / in_stream->time_base.den, packet->pts, packet->dts, packet->pos, packet->size);
              // printf("before packet out start: %f,  pts: %lld, dts: %lld, pos: %lld, size: %d \n", static_cast<double>(packet->pts) / in_stream->time_base.den, packet->pts, packet->dts, packet->pos, packet->size);
              // keyframe_index = keyframe_index + 1;
            }

            // previous_packet_pts = packet->pts;

            av_packet_unref(packet);
            if (!is_last_chunk && used_output_input + avio_ctx_buffer_size > processed_bytes) {
              // printf("STOPPED TRYING TO READ FRAMES AS THERE IS NOT ENOUGH DATA ANYMORE %d/%d:%d \n", used_input, processed_bytes, input_size);
              break;
            }
          }
        }
      }

      if (is_last_chunk && processed_bytes + avio_ctx_buffer_size > processed_bytes) {
        printf("packet %d end %f\n", keyframe_index, static_cast<double>(previous_packet_pts) / in_stream->time_base.den);
        keyframe_end_time = static_cast<double>(previous_packet_pts) / in_stream->time_base.den;
        av_write_trailer(output_format_context);
        av_packet_free(&packet);
        avformat_free_context(input_format_context);
        avformat_free_context(output_format_context);
        avformat_free_context(output_input_format_context);
        // avio_close(avioContext);
        // avio_close(avioContext2);
        // avio_close(avioContext3);
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

    void seek() {
      printf("seek");
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

  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    // printf("readFunction %#x | %s | %d \n", buf, &buf, buf_size);
    // printf("readFunction %#x | %s | %d \n", buf, &buf, buf_size);
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    remuxObject.used_input += buf_size;
    auto& stream = remuxObject.input_stream;
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    auto gcount = stream.gcount();
    if (gcount == 0) {
      return AVERROR_EOF;
    }
    return stream.gcount();
  }

  static int readOutputFunction(void* opaque, uint8_t* buf, int buf_size) {
    printf("readOutputFunction %#x | %s | %d \n", buf, &buf, buf_size);
    // printf("readFunction %#x | %s | %d \n", buf, &buf, buf_size);
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    remuxObject.used_output_input += buf_size;
    auto& stream = remuxObject.output_input_stream;
    stream.read(reinterpret_cast<char*>(buf), buf_size);
    return stream.gcount();
  }

  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    auto& remuxObject = *reinterpret_cast<Remuxer*>(opaque);
    // auto& callback = remuxObject.callback;
    // callback("test datawriteFunction ", callback);
    // if (callback.as<bool>()) {
    //   callback(static_cast<std::string>("data"), remuxObject.keyframe_index - 2, remuxObject.keyframe_start_time, remuxObject.keyframe_end_time, buf_size, remuxObject.written_output, 
      
    //   // emscripten::val(
    //   //   emscripten::typed_memory_view(
    //   //     buf_size,
    //   //     buf
    //   //   )
    //   // )
    //   );
    //   // callback(reinterpret_cast<char*>("data"), remuxObject.keyframe_index - 2, remuxObject.keyframe_start_time, remuxObject.keyframe_end_time);
    // }
    // remuxObject.callback();
    // callback(remuxObject.keyframe_index - 2);
    // callback("data", remuxObject.keyframe_index - 2, remuxObject.keyframe_start_time, remuxObject.keyframe_end_time);
    printf("writeFunction %d | %d | %d \n", remuxObject.keyframe_index - 2, buf_size, remuxObject.written_output);
    auto& stream = remuxObject.output_stream;
    remuxObject.written_output += buf_size;
    stream.write(reinterpret_cast<char*>(buf), buf_size);
    // auto& stream2 = remuxObject.output_input_stream;
    // stream2.write(reinterpret_cast<char*>(buf), buf_size);
    // if (callback.as<bool>()) {
    //   callback(static_cast<std::string>("data"), remuxObject.keyframe_index - 2, remuxObject.keyframe_start_time, remuxObject.keyframe_end_time, buf_size, remuxObject.written_output, remuxObject.getInt8Array());
    //   // callback(reinterpret_cast<char*>("data"), remuxObject.keyframe_index - 2, remuxObject.keyframe_start_time, remuxObject.keyframe_end_time);
    // }
    return stream.gcount();
  }

  static int64_t seekFunction(void* opaque, int64_t offset, int whence) {
    // printf("seekFunction %d | %d \n", offset, whence);
    // printf("seekFunction %#x | %d \n", offset, whence);
    return -1;
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
      .constructor<int>()
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
