// @ts-ignore
import { createFile } from 'mp4box'

// @ts-ignore
declare module "mp4box" {

  export interface MP4MediaTrack {
      id: number;
      created: Date;
      modified: Date;
      movie_duration: number;
      layer: number;
      alternate_group: number;
      volume: number;
      track_width: number;
      track_height: number;
      timescale: number;
      duration: number;
      bitrate: number;
      codec: string;
      language: string;
      nb_samples: number;
  }

  export  interface MP4VideoData {
      width: number;
      height: number;
  }

  export  interface MP4VideoTrack extends MP4MediaTrack {
      video: MP4VideoData;
  }

  export  interface MP4AudioData {
      sample_rate: number;
      channel_count: number;
      sample_size: number;
  }

  export  interface MP4AudioTrack extends MP4MediaTrack {
      audio: MP4AudioData;
  }

  export  type MP4Track = MP4VideoTrack | MP4AudioTrack;

  export interface MP4Info {
      duration: number;
      timescale: number;
      fragment_duration: number;
      isFragmented: boolean;
      isProgressive: boolean;
      hasIOD: boolean;
      brands: string[];
      created: Date;
      modified: Date;
      tracks: MP4Track[];
  }

  export type MP4ArrayBuffer = ArrayBuffer & {fileStart: number};

  export interface MP4File {

      onMoovStart?: () => void;
      onReady?: (info: MP4Info) => void;
      onError?: (e: string) => void;

      appendBuffer(data: MP4ArrayBuffer): number;
      start(): void;
      stop(): void;
      flush(): void;

  }

  export function createFile(): MP4File;

  export { };

}


export interface MP4MediaTrack {
    id: number;
    created: Date;
    modified: Date;
    movie_duration: number;
    layer: number;
    alternate_group: number;
    volume: number;
    track_width: number;
    track_height: number;
    timescale: number;
    duration: number;
    bitrate: number;
    codec: string;
    language: string;
    nb_samples: number;
}

export  interface MP4VideoData {
    width: number;
    height: number;
}

export  interface MP4VideoTrack extends MP4MediaTrack {
    video: MP4VideoData;
}

export  interface MP4AudioData {
    sample_rate: number;
    channel_count: number;
    sample_size: number;
}

export  interface MP4AudioTrack extends MP4MediaTrack {
    audio: MP4AudioData;
}

export  type MP4Track = MP4VideoTrack | MP4AudioTrack;

export interface MP4Info {
    duration: number;
    timescale: number;
    fragment_duration: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    tracks: MP4Track[];
}

export type MP4ArrayBuffer = ArrayBuffer & {fileStart: number};

export interface MP4File {

    onMoovStart?: () => void;
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;

    appendBuffer(data: MP4ArrayBuffer): number;
    start(): void;
    stop(): void;
    flush(): void;

}

// @ts-ignore
export function createFile(): MP4File;

export { createFile };
