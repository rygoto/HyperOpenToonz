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

/** 背景動画トラックの音声を、トラックIDごとにデコードしておく */
export async function decodeBgAudio(tracks) {
  const out = new Map()
  for (const track of tracks) {
    if (track.type !== 'bg' || track.kind !== 'video' || track.muted || !track.url) continue
    try {
      const ctx = audioContext()
      const bytes = await fetch(track.url).then((r) => r.arrayBuffer())
      out.set(track.id, await ctx.decodeAudioData(bytes))
    } catch {
      /* 音声を持たない動画は黙って飛ばす */
    }
  }
  return out
}

/** クリップの並びどおりに buffer を鳴らす */
function scheduleClips(ctx, master, track, buffer, gainValue, dur) {
  for (const clip of track.clips) {
    const skip = Math.max(0, clip.in)
    const playDur = Math.min(clip.len, buffer.duration - skip, dur - clip.start)
    if (playDur <= 0.001 || clip.start >= dur) continue
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = gainValue
    src.connect(gain)
    gain.connect(master)
    src.start(Math.max(0, clip.start), skip, playDur)
  }
}

/**
 * 背景動画の音声 + 音声クリップを 1 本の AudioBuffer に混ぜる。
 * プレビューのミュートは見ず、各トラックの gain / muted を使う。
 */
export async function mixProjectAudio({ tracks, bgBuffers, duration, volume = 1 }) {
  const dur = Math.max(0.05, duration)
  const sampleRate = 48000
  const length = Math.max(1, Math.ceil(dur * sampleRate))
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!Ctor) return null

  const ctx = new Ctor(2, length, sampleRate)
  const master = ctx.createGain()
  master.gain.value = volume
  master.connect(ctx.destination)

  for (const track of tracks) {
    if (track.type === 'audio') {
      if (track.muted || !track.buffer) continue
      scheduleClips(ctx, master, track, track.buffer, track.gain, dur)
      continue
    }
    if (track.type === 'bg' && track.kind === 'video' && !track.muted) {
      const buffer = bgBuffers?.get(track.id)
      if (buffer && buffer.duration > 0) scheduleClips(ctx, master, track, buffer, 1, dur)
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
