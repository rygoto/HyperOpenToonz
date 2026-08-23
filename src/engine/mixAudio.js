import { audioContext } from './audio.js'

/** H.264 は偶数解像度が必要なので揃える */
export function evenSize(n) {
  const x = Math.max(2, Math.round(Number(n) || 0))
  return x + (x % 2)
}

/**
 * dst に src を加算する。クリップの配置計算のテスト用。
 * destOffset / srcOffset はサンプル番号。
 */
export function mixSamples(dst, src, destOffset, srcOffset, count, gain = 1) {
  const n = Math.min(count, dst.length - destOffset, src.length - srcOffset)
  if (n <= 0 || destOffset < 0 || srcOffset < 0) return 0
  for (let i = 0; i < n; i++) dst[destOffset + i] += src[srcOffset + i] * gain
  return n
}

export async function decodeBackgroundAudio(background) {
  if (!background?.url || background.kind !== 'video') return null
  try {
    const ctx = audioContext()
    const bytes = await fetch(background.url).then((r) => r.arrayBuffer())
    return await ctx.decodeAudioData(bytes)
  } catch {
    return null
  }
}

/**
 * 背景動画の音声 + 音声クリップを 1 本の AudioBuffer に混ぜる。
 * プレビューのミュートは見ず、各トラックの gain / muted を使う。
 */
export async function mixProjectAudio({ tracks, backgroundBuffer, duration, volume = 1 }) {
  const dur = Math.max(0.05, duration)
  const sampleRate = 48000
  const length = Math.max(1, Math.ceil(dur * sampleRate))
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!Ctor) return null

  const ctx = new Ctor(2, length, sampleRate)
  const master = ctx.createGain()
  master.gain.value = volume
  master.connect(ctx.destination)

  if (backgroundBuffer && backgroundBuffer.duration > 0) {
    const src = ctx.createBufferSource()
    src.buffer = backgroundBuffer
    src.connect(master)
    src.start(0)
  }

  for (const track of tracks) {
    if (track.type !== 'audio' || track.muted || !track.buffer) continue
    for (const clip of track.clips) {
      const skip = Math.max(0, clip.in)
      const playDur = Math.min(clip.len, track.buffer.duration - skip, dur - clip.start)
      if (playDur <= 0.001 || clip.start >= dur) continue
      const src = ctx.createBufferSource()
      src.buffer = track.buffer
      const gain = ctx.createGain()
      gain.gain.value = track.gain
      src.connect(gain)
      gain.connect(master)
      src.start(Math.max(0, clip.start), skip, playDur)
    }
  }

  return ctx.startRendering()
}

export function bufferHasSignal(buffer) {
  if (!buffer) return false
  const n = Math.min(buffer.length, 48000)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) {
      if (d[i] !== 0) return true
    }
  }
  return false
}
