import type { Media } from '@videojs/core/dom'

import { useEffect } from 'react'
import { videoFeatures } from '@videojs/core/dom'
import { createPlayer, useMediaAttach } from '@videojs/react'
import { VideoSkin } from '@videojs/react/video'
import '@videojs/react/video/skin.css'

// Video.js v10 attaches a structural "media" object (EventTarget + the media-element surface), not a
// <video> tag. A real HTMLMediaElement satisfies the whole contract, so the decode-render audio
// element (the timeline + clock from createDecodeRenderMedia) goes straight to setMedia(); the
// <canvas> the worker draws onto sits behind the transparent skin.

const { Provider } = createPlayer({ features: videoFeatures })

// The video skin preset paints a solid background that would hide the canvas behind it.
const SKIN_TRANSPARENT = '.media-default-skin--video { background: transparent !important; }'

const MediaAttach = ({ media }: { media: HTMLMediaElement }) => {
  const setMedia = useMediaAttach()
  useEffect(() => {
    if (!setMedia) return
    setMedia(media as unknown as Media)
    return () => setMedia(null)
  }, [media, setMedia])
  return null
}

export const VideoJsPlayer = ({ media }: { media: HTMLMediaElement }) => (
  <Provider>
    <MediaAttach media={media} />
    <style>{SKIN_TRANSPARENT}</style>
    <VideoSkin style={{ position: 'absolute', inset: 0, background: 'transparent' }} />
  </Provider>
)
