let sharedCtx = null

export function audioContext() {
  if (!sharedCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    sharedCtx = new Ctor()
  }
  return sharedCtx
}

/** 波形表示用に区間ごとの最大振幅を作る */
export function computePeaks(buffer, buckets = 6000) {
  const n = buffer.length
  const size = Math.max(1, Math.floor(n / buckets))
  const count = Math.ceil(n / size)
  const peaks = new Float32Array(count)
  const chans = []
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    chans.push(buffer.getChannelData(c))
  }
  for (let i = 0; i < count; i++) {
    const s = i * size
    const e = Math.min(n, s + size)
    let m = 0
    for (const d of chans) {
      for (let j = s; j < e; j++) {
        const v = d[j] < 0 ? -d[j] : d[j]
        if (v > m) m = v
      }
    }
    peaks[i] = m
  }
  return peaks
}

export async function decodeAudioFile(file) {
  const ctx = audioContext()
  const bytes = await file.arrayBuffer()
  const buffer = await ctx.decodeAudioData(bytes)
  return {
    buffer,
    duration: buffer.duration,
    peaks: computePeaks(buffer),
  }
}

/**
 * 音声クリップを Web Audio でスケジュール再生する。
 * タイムベースは clock 側なので、ここは「今の再生位置から先の分を並べ直す」
 * だけを担当し、ズレが一定を超えたら組み直す。
 */
export function createAudioEngine() {
  let ctx = null
  let master = null
  let sources = []
  let playing = false
  let anchorCtxTime = 0
  let anchorTime = 0
  let anchorRate = 1
  let anchorTracks = null
  let lastVolume = -1

  function ensure() {
    if (!ctx) {
      ctx = audioContext()
      master = ctx.createGain()
      master.connect(ctx.destination)
    }
    return ctx
  }

  function stopAll() {
    for (const s of sources) {
      try {
        s.stop()
      } catch {
        /* すでに停止済み */
      }
      s.disconnect()
    }
    sources = []
    playing = false
    anchorTracks = null
  }

  function schedule(tracks, time, rate) {
    stopAll()
    ensure()
    if (ctx.state === 'suspended') ctx.resume()

    const t0 = ctx.currentTime + 0.06
    anchorCtxTime = t0
    anchorTime = time
    anchorRate = rate
    anchorTracks = tracks
    playing = true

    for (const track of tracks) {
      if (track.type !== 'audio' || track.muted || !track.buffer) continue
      for (const clip of track.clips) {
        const end = clip.start + clip.len
        if (end <= time) continue
        const skip = Math.max(0, time - clip.start) // クリップ内で飛ばす秒数
        const dur = clip.len - skip
        if (dur <= 0.001) continue
        const offset = clip.in + skip
        if (offset >= track.buffer.duration) continue

        const node = ctx.createBufferSource()
        node.buffer = track.buffer
        node.playbackRate.value = rate
        const gain = ctx.createGain()
        gain.gain.value = track.gain
        node.connect(gain)
        gain.connect(master)
        node.start(
          t0 + Math.max(0, (clip.start - time) / rate),
          offset,
          Math.min(dur, track.buffer.duration - offset),
        )
        node.onended = () => gain.disconnect()
        sources.push(node)
      }
    }
  }

  return {
    /** 最初のユーザー操作で AudioContext を起こしておく */
    unlock() {
      const c = ensure()
      if (c.state === 'suspended') c.resume()
    },

    /** 毎フレーム呼ぶ。必要なときだけ組み直す */
    sync({ playing: want, time, rate, tracks, volume }) {
      const hasAudio = tracks.some((t) => t.type === 'audio' && t.buffer)
      if (!want || !hasAudio) {
        if (playing) stopAll()
        return
      }
      ensure()
      if (volume !== lastVolume) {
        master.gain.value = volume
        lastVolume = volume
      }
      if (!playing || tracks !== anchorTracks || rate !== anchorRate) {
        schedule(tracks, time, rate)
        return
      }
      const expected = anchorTime + (ctx.currentTime - anchorCtxTime) * anchorRate
      if (Math.abs(expected - time) > 0.12) schedule(tracks, time, rate)
    },

    dispose() {
      stopAll()
    },
  }
}
