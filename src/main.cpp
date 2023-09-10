#include <emscripten.h>
#include <emscripten/bind.h>
#include "obfuscate.h"

using namespace emscripten;

extern "C" {
  #include <libavcodec/bsf.h>
  #include <libavformat/avio.h>
  #include <libavcodec/avcodec.h>
  #include <libavformat/avformat.h>
};

int main() {
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
    AVBSFContext *bitstream_filter_context;
    const AVBitStreamFilter *bitstream_filter = av_bsf_get_by_name("hevc_mp4toannexb");
    uint8_t* input_avio_buffer;
    uint8_t* output_avio_buffer;
    int stream_index;
    int *streams_list;
    int number_of_streams;
    // float input_length;
    int buffer_size;
    int video_stream_index;

    bool is_header;
    bool is_flushing;
    long prev_pos;
    double prev_pts;
    double prev_duration;
    long pos;
    double pts;
    double duration;
    bool first_frame = true;

    val read = val::undefined();
    val attachment = val::undefined();
    val subtitle = val::undefined();
    val write = val::undefined();
    val seek = val::undefined();
    val error = val::undefined();

    static void print_dict(const AVDictionary *m)
    {
        AVDictionaryEntry *t = nullptr;
        while ((t = av_dict_get(m, "", t, AV_DICT_IGNORE_SUFFIX)))
            printf("%s %s   ", t->key, t->value);
        printf("\n");
    }

    bool hostname_check() {
      std::string hostStr = val::global("location")["host"].as<std::string>();
      std::string originStr = val::global("location")["origin"].as<std::string>();
      const char* str = hostStr.c_str();
      const char* originstr = originStr.c_str();
      std::string hostStdString(str);
      std::string originStdString(originstr);
      std::string sdbxAppHost(AY_OBFUSCATE("sdbx.app"));
      std::string localhostProxyHost(AY_OBFUSCATE("localhost:2345"));
      std::string localhostAppTest(AY_OBFUSCATE("localhost:4560"));
      if (
        strcmp(originstr, AY_OBFUSCATE("http://localhost:1234")) != 0 &&
        strcmp(originstr, AY_OBFUSCATE("http://localhost:2345")) != 0 &&
        strcmp(originstr, AY_OBFUSCATE("http://localhost:4560")) != 0 &&
        strcmp(str, AY_OBFUSCATE("dev.fkn.app")) != 0 &&
        strcmp(str, AY_OBFUSCATE("fkn.app")) != 0 &&
        !strstr(hostStdString.c_str(), sdbxAppHost.c_str()) &&
        !strstr(hostStdString.c_str(), sdbxAppHost.c_str()) &&
        !strstr(originStdString.c_str(), sdbxAppHost.c_str()) &&
        !strstr(originStdString.c_str(), sdbxAppHost.c_str()) &&
        strcmp(str, AY_OBFUSCATE("localhost:1234")) != 0 &&
        strcmp(str, AY_OBFUSCATE("localhost:2345")) != 0 &&
        strcmp(str, AY_OBFUSCATE("localhost:4560")) != 0 &&
        !strstr(hostStdString.c_str(), localhostProxyHost.c_str()) &&
        !strstr(hostStdString.c_str(), localhostAppTest.c_str()) &&
        !strstr(originStdString.c_str(), localhostProxyHost.c_str()) &&
        !strstr(originStdString.c_str(), localhostAppTest.c_str())
      ) return false;
      
      return true;
    }

    Transmuxer(val options) {
      if (!hostname_check()) return;
      // input_length = options["length"].as<float>();
      buffer_size = options["bufferSize"].as<int>();
      read = options["read"];
      attachment = options["attachment"];
      subtitle = options["subtitle"];
      write = options["write"];
      seek = options["seek"];
      error = options["error"];
    }

    void init (bool first_init) {
      if (!hostname_check()) return;
      int res;
      is_header = true;
      duration = 0;
      first_frame = true;

      input_avio_context = nullptr;
      input_format_context = avformat_alloc_context();
      // output_format_context = avformat_alloc_context();

      stream_index = 0;
      streams_list = nullptr;
      number_of_streams = 0;

      // Initialize the input avio context
      input_avio_buffer = static_cast<uint8_t*>(av_malloc(buffer_size));
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
        printf("ERROR: could not open format context input | %s \n", av_err2str(res));
        return;
      }
      if ((res = avformat_find_stream_info(input_format_context, NULL)) < 0) {
        printf("ERROR: could not get input_stream info | %s \n", av_err2str(res));
        return;
      }

      // Initialize the output avio context
      output_avio_buffer = static_cast<uint8_t*>(av_malloc(buffer_size));
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
      // output_format_context->flags |= AVFMT_FLAG_CUSTOM_IO;

      number_of_streams = input_format_context->nb_streams;
      streams_list = (int *)av_calloc(number_of_streams, sizeof(*streams_list));

      if (!streams_list) {
        res = AVERROR(ENOMEM);
        printf("ERROR: could not allocate a stream list | %s \n", av_err2str(res));
        return;
      }

      // Loop through all of the input streams
      for (int i = 0; i < input_format_context->nb_streams; i++) {
        AVStream *out_stream;
        AVStream *in_stream = input_format_context->streams[i];
        AVStream *out_in_stream;
        AVCodecParameters *in_codecpar = in_stream->codecpar;

        // Filter out all non video/audio/subtitles/attachments streams
        if (
          in_codecpar->codec_type != AVMEDIA_TYPE_AUDIO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_VIDEO &&
          in_codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE &&
          in_codecpar->codec_type != AVMEDIA_TYPE_ATTACHMENT
        ) {
          streams_list[i] = -1;
          continue;
        }

        // call the JS attachment callback and continue to next stream
        if (in_codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
          if (!first_init) continue;
          // Get attachment codec context
          // AVCodec*
          auto codec = avcodec_find_decoder(in_codecpar->codec_id);
          AVCodecContext* codecCtx = avcodec_alloc_context3(codec);
          avcodec_parameters_to_context(codecCtx, in_codecpar);
          // Get filename and mimetype of the attachment
          AVDictionaryEntry* filename_entry = av_dict_get(in_stream->metadata, "filename", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string filename = std::string(filename_entry->value);
          AVDictionaryEntry* mimetype_entry = av_dict_get(in_stream->metadata, "mimetype", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string mimetype = std::string(mimetype_entry->value);
          // call the js attachment callback
          attachment(
            filename,
            mimetype,
            emscripten::val(
              emscripten::typed_memory_view(
                codecCtx->extradata_size,
                codecCtx->extradata
              )
            )
          );
          // cleanup
          avcodec_free_context(&codecCtx);
          continue;
        }

        // call the JS subtitle callback and continue to next stream
        if (in_codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          // Get subtitle codec context
          // AVCodec*
          auto codec = avcodec_find_decoder(in_codecpar->codec_id);
          AVCodecContext* codecCtx = avcodec_alloc_context3(codec);
          avcodec_parameters_to_context(codecCtx, in_codecpar);
          // allocate space for the subtitle extradata(header)
          codecCtx->subtitle_header = static_cast<uint8_t*>(av_malloc(codecCtx->extradata_size + 1));
          if (!codecCtx->subtitle_header) {
            res = AVERROR(ENOMEM);
            printf("ERROR: could not allocate subtitle headers | %s \n", av_err2str(res));
            continue;
          }
          /**
           * Copy the contents of the subtitle header manually,
           * as its format is pretty simple and we don't want
           * to include the actual heavy subtitle decoder
           */
          if (codecCtx->extradata_size) {
            memcpy(codecCtx->subtitle_header, codecCtx->extradata, codecCtx->extradata_size);
          }
          codecCtx->subtitle_header[codecCtx->extradata_size] = 0;
          codecCtx->subtitle_header_size = codecCtx->extradata_size;
          // Get language and title of the subtitle
          AVDictionaryEntry* language_entry = av_dict_get(in_stream->metadata, "language", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string language = std::string(language_entry->value);
          AVDictionaryEntry* title_entry = av_dict_get(in_stream->metadata, "title", NULL, AV_DICT_IGNORE_SUFFIX);
          std::string title = std::string(title_entry->value);
          std::string data = reinterpret_cast<char*>(codecCtx->subtitle_header);
          if (first_init) {
            // call the js subtitle callback
            subtitle(
              i,
              true,
              data,
              language,
              title
            );
          }
          // cleanup
          av_free(codecCtx->subtitle_header);
          codecCtx->subtitle_header = NULL;
          avcodec_free_context(&codecCtx);
          continue;
        }

        // Assign the video stream index to a global variable that'll be used when seeking forwards
        if (in_codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          video_stream_index = i;
        }

        streams_list[i] = stream_index++;
        // Open a new output stream
        out_stream = avformat_new_stream(output_format_context, NULL);
        if (!out_stream) {
          res = AVERROR_UNKNOWN;
          printf("ERROR: could not allocate output stream | %s \n", av_err2str(res));
          return;
        }
        // Copy all of the input file codecs to the output file codecs
        if ((res = avcodec_parameters_copy(out_stream->codecpar, in_codecpar)) < 0) {
          printf("ERROR: could not copy codec parameters | %s \n", av_err2str(res));
          return;
        }
      }

      AVDictionary* opts = nullptr;
      // Force transmuxing instead of re-encoding by copying the codecs
      av_dict_set(&opts, "c", "copy", 0);
      // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
      // Fragment the MP4 output
      av_dict_set(&opts, "movflags", "frag_keyframe+empty_moov+default_base_moof", 0);

      // Writes the header of the output
      if ((res = avformat_write_header(output_format_context, &opts)) < 0) {
        printf("ERROR: could not write output header | %s \n", av_err2str(res));
        return;
      }
      write(
        static_cast<long>(input_format_context->pb->pos),
        NULL,
        is_header,
        true,
        0,
        0,
        0
      );
    }

    void process(double time_to_process) {
      printf("processing \n");
      int res;
      double start_process_pts = 0;
      std::vector<AVPacket*> packet_buffer;
      // std::vector<bool> packet_buffer = std::vector<bool>();
      // packet_buffer.push_back(false);
      // packet_buffer.push_back(true);

      // loop through the packet frames until we reach the processed size
      while (start_process_pts == 0 || (pts < (start_process_pts + time_to_process))) {
        AVPacket* packet = av_packet_alloc();

        if ((res = av_read_frame(input_format_context, packet)) < 0) {
          printf("ERROR: could not read frame | %s \n", av_err2str(res));
          break;
        }

        AVStream* in_stream = input_format_context->streams[packet->stream_index];
        AVStream* out_stream = output_format_context->streams[packet->stream_index];

        // if (packet->dts == packet->pts) {
        //   packet->dts = AV_NOPTS_VALUE;
        // }

        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
          printf("processing packet, packet->pts: %lld | packet->dts: %lld, PTS: %f \n", packet->pts, packet->dts, packet->pts * av_q2d(out_stream->time_base));
        }

        // if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && packet->dts == AV_NOPTS_VALUE) {
        //   packet->dts = packet->pts;
        // }

        if (packet->stream_index >= number_of_streams || streams_list[packet->stream_index] < 0) {
          // free packet as it's not in a used stream and continue to next packet
          av_packet_unref(packet);
          av_packet_free(&packet);
          continue;
        }

        // Read subtitle packet and call JS subtitle callback
        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
          long start = packet->pts;
          long end = start + packet->duration;
          std::string data = reinterpret_cast<char *>(packet->data);
          // call JS subtitle callback
          subtitle(
            packet->stream_index,
            false,
            data,
            start,
            end
          );
          av_packet_unref(packet);
          av_packet_free(&packet);
          continue;
        }

        // Read audio packet and write it to the output context
        if (in_stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
          av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
          if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
            printf("ERROR: could not write interleaved frame | %s \n", av_err2str(res));
          }
          av_packet_unref(packet);
          av_packet_free(&packet);
          continue;
        }

        bool is_keyframe = packet->flags & AV_PKT_FLAG_KEY;

        // printf("keyframe DTS, packet info: is_keyframe %d, packet->stream_index: %d packet->pts: %lld | packet->dts: %lld | packet->duration: %lld | packet->pos: %lld, timestamp: %f\n", is_keyframe, packet->stream_index, packet->pts, packet->dts, packet->duration, packet->pos, packet->pts * av_q2d(out_stream->time_base));
        // printf("processing packet, packet->pts: %lld | packet->dts: %lld \n", packet->pts, packet->dts);

        // Rescale the PTS/DTS from the input time base to the output time base
        av_packet_rescale_ts(packet, in_stream->time_base, out_stream->time_base);
        // printf("packet size %d, %zu \n", packet->size, packet->side_data->size);

        if (!start_process_pts) {
          start_process_pts = packet->pts * av_q2d(out_stream->time_base);
        }

        // Set needed pts/pos/duration needed to calculate the real timestamps
        if (is_keyframe) {
          // printf("is_keyframe, DTS %f, PTS %f \n", packet->dts * av_q2d(out_stream->time_base), packet->pts * av_q2d(out_stream->time_base));
          std::sort(packet_buffer.begin(), packet_buffer.end(), [](const AVPacket* a, const AVPacket* b) -> bool {
              return a->dts < b->dts;
          });
          for (AVPacket* buffered_packet : packet_buffer) {
            // printf("processing buffered_packet, packet->pts: %lld | packet->dts: %lld, PTS: %f \n", buffered_packet->pts, buffered_packet->dts, buffered_packet->pts * av_q2d(out_stream->time_base));
            duration += buffered_packet->duration * av_q2d(out_stream->time_base);
            if ((res = av_interleaved_write_frame(output_format_context, buffered_packet)) < 0) {
              printf("ERROR: could not write interleaved frame | %s \n", av_err2str(res));
              continue;
            }

            av_packet_unref(buffered_packet);
            av_packet_free(&buffered_packet);
          }
          packet_buffer.clear();

          // printf("processing keyframe, packet->pts: %lld | packet->dts: %lld, PTS: %f \n", packet->pts, packet->dts, packet->pts * av_q2d(out_stream->time_base));
          bool was_header = is_header;
          if (was_header) {
            is_header = false;
          } else {
            is_flushing = true;
          }

          prev_duration = duration;
          prev_pts = pts;
          prev_pos = pos;

          duration = 0;

          pts = packet->pts * av_q2d(out_stream->time_base);
          pos = packet->pos;
        } else {
          packet_buffer.push_back(packet);
          continue;
        }

        // Write the frames to the output context
        if ((res = av_interleaved_write_frame(output_format_context, packet)) < 0) {
          printf("ERROR: could not write interleaved frame | %s \n", av_err2str(res));
          continue;
        }

        // free packet
        av_packet_unref(packet);
        av_packet_free(&packet);
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

    int64_t getInputPosition () {
      return input_avio_context->pos;
    }

    int64_t getOutputPosition () {
      return output_avio_context->pos;
    }

    int _seek(int timestamp, int flags) {
      destroy();
      init(false);

      process(0.01);

      int res;
      prev_duration = 0;
      prev_pts = 0;
      prev_pos = 0;
      duration = 0;
      pts = 0;
      pos = 0;
      if ((res = av_seek_frame(input_format_context, video_stream_index, timestamp, flags)) < 0) {
        printf("ERROR: could not seek frame | %s \n", av_err2str(res));
      }
      return 0;
    }

    void destroy () {
      // check if we need to write trailer at some point
      // av_write_trailer(output_format_context);

      av_freep(streams_list);
      streams_list = nullptr;

      // avformat_close_input calls avformat_free_context itself
      // avformat_close_input(&input_format_context);

      // We have to free like this, as reported by https://fftrac-bg.ffmpeg.org/ticket/1357
      av_free(input_avio_context->buffer);
      // av_freep(&input_avio_buffer);
      input_avio_buffer = nullptr;
      avio_context_free(&input_avio_context);
      input_avio_context = nullptr;
      avformat_close_input(&input_format_context);
      // avformat_free_context(input_format_context);
      input_format_context = nullptr;

      av_free(output_avio_context->buffer);
      avio_context_free(&output_avio_context);
      output_avio_context = nullptr;
      avformat_free_context(output_format_context);
      output_format_context = nullptr;
      // av_free(output_avio_buffer);
      // output_avio_buffer = nullptr;
    }
  };

  // Seek callback called by AVIOContext
  static int64_t seekFunction(void* opaque, int64_t offset, int whence) {
    Transmuxer &remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    emscripten::val &seek = remuxObject.seek;
    // call the JS seek function
    double result = seek(static_cast<double>(offset), whence).await().as<double>();
    return result;
  }

  // If emscripten asynchify ever start working for libraries callbacks,
  // replace the blocking write function with an async callback

  // Read callback called by AVIOContext
  static int readFunction(void* opaque, uint8_t* buf, int buf_size) {
    Transmuxer &remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    emscripten::val &read = remuxObject.read;
    // call the JS read function and get its result as
    // {
    //   buffer: Uint8Array,
    //   size: int
    // }
    val res = read(static_cast<long>(remuxObject.input_format_context->pb->pos), buf_size).await();
    std::string buffer = res["buffer"].as<std::string>();
    int buffer_size = res["size"].as<int>();
    // copy the result buffer into AVIO's buffer
    memcpy(buf, (uint8_t*)buffer.c_str(), buffer_size);
    // If result buffer size is 0, we reached the end of the file
    if (buffer_size == 0) {
      return AVERROR_EOF;
    }
    return buffer_size;
  }

  // Write callback called by AVIOContext
  static int writeFunction(void* opaque, uint8_t* buf, int buf_size) {
    Transmuxer &remuxObject = *reinterpret_cast<Transmuxer*>(opaque);
    emscripten::val &write = remuxObject.write;
    // call the JS write function

    printf("writeFunction, prev_pts: %f, duration: %f \n", remuxObject.prev_pts, remuxObject.prev_duration);

    write(
      static_cast<long>(remuxObject.input_format_context->pb->pos),
      emscripten::val(
        emscripten::typed_memory_view(
          buf_size,
          buf
        )
      ),
      remuxObject.is_header,
      remuxObject.is_flushing,
      remuxObject.prev_pos,
      remuxObject.prev_pts,
      remuxObject.prev_duration
    ).await();

    if (remuxObject.is_flushing) {
      remuxObject.is_flushing = false;
    }

    return buf_size;
  }

  // Binding code
  EMSCRIPTEN_BINDINGS(libav_wasm) {

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
