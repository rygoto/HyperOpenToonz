import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import { composite } from './compositor.js'
import { activeClip, bgSourceTime } from './timeline.js'
import { evenSize, bufferHasSignal, decodeBgAudio, mixProjectAudio } from './mixAudio.js'

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('書き出しをキャンセルしました')
    err.name = 'AbortError'
    throw err
  }
}

/**
 * 背景動画を指定時刻へシークして、そのフレームが描ける状態にする。
 * 書き出しでは下の frameReaders を優先し、これは素材の実物が無いときの予備。
 */
export function seekVideo(el, time) {
  return new Promise((resolve) => {
    if (!el || typeof el.currentTime !== 'number') {
      resolve()
      return
    }
    const dur = Number.isFinite(el.duration) ? el.duration : 0
    const target = dur > 0 ? Math.min(Math.max(0, time), Math.max(0, dur - 0.04)) : Math.max(0, time)
    if (el.readyState >= 2 && Math.abs(el.currentTime - target) < 1 / 120) {
      resolve()
      return
    }
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      el.removeEventListener('seeked', done)
      el.removeEventListener('error', done)
      resolve()
    }
    const presented = () => {
      // seeked の時点ではまだ新しい絵が出ていないことがあるので、表示されるまで待つ
      if (typeof el.requestVideoFrameCallback === 'function') {
        el.requestVideoFrameCallback(() => done())
        window.setTimeout(done, 1000)
      } else {
        done()
      }
    }
    el.addEventListener('seeked', presented, { once: true })
    el.addEventListener('error', done)
    try {
      el.pause()
      el.currentTime = target
    } catch {
      done()
      return
    }
    // キーフレームの少ない動画は後ろほどシークが遅い。諦めるのは本当に止まったときだけ
    window.setTimeout(done, 10000)
  })
}

/*
 * 書き出しのコマは <video> をシークせず、mediabunny で素材をデコードして取る。
 * <video> のシークは seeked が来ても絵が間に合っていなかったり、キーフレームが1つしかない
 * 動画だと後半ほど遅くなって待ちきれなかったりして、コマが止まる・真っ黒になる(ちらつく)。
 * デコーダを直接使えば、狙った時刻のコマが必ず取れて、頭から順に読むので速い。
 */

// 素材のコマの時刻は 1/24 秒などから僅かにずれて入っていることがあるので、少しだけ後ろを見る
const FRAME_EPSILON = 0.002

/** 1本の背景動画から、times[i](null はそのコマで使わない)に当たる絵を順に取り出す */
async function openFrameReader(track, times) {
  const file = track.sources?.[0]
  if (!file) return null
  let input = null
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(await video.canDecode())) {
      input.dispose()
      return null
    }
    const sink = new CanvasSink(video, { poolSize: 0 })
    const frames = sink.canvasesAtTimestamps(times.filter((t) => t != null))
    let last = null
    return {
      /** i コマ目の絵(そのコマで使わない動画なら直前のまま) */
      async at(i) {
        if (times[i] == null) return last
        const { value } = await frames.next()
        if (value?.canvas) last = value.canvas
        return last
      },
      async close() {
        await frames.return?.()
        input.dispose()
      },
    }
  } catch {
    input?.dispose()
    return null
  }
}

/** 書き出す全コマぶん、背景動画ごとの読み手を用意する(用意できない動画は <video> のシークに任せる) */
async function frameReaders(view, total, dt, duration) {
  const readers = new Map()
  for (const track of view.tracks) {
    if (track.type !== 'bg' || track.kind !== 'video' || !track.el) continue
    const times = []
    for (let i = 0; i < total; i++) {
      const t = Math.min(duration, i * dt)
      const clip = activeClip(track, t)
      times.push(clip ? bgSourceTime(track, clip, t) + FRAME_EPSILON : null)
    }
    const reader = await openFrameReader(track, times)
    if (reader) readers.set(track.id, reader)
  }
  return readers
}

async function closeReaders(readers) {
  for (const r of readers.values()) {
    try {
      await r.close()
    } catch {
      /* 片付けに失敗しても書き出した結果には響かない */
    }
  }
}

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  const list = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || ''
}

async function prepareCanvas(view) {
  const canvas = document.createElement('canvas')
  canvas.width = evenSize(view.width)
  canvas.height = evenSize(view.height)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false })
  const exportView = {
    ...view,
    width: canvas.width,
    height: canvas.height,
    checker: false,
    bgColor: view.bgColor || '#000000',
  }
  return { canvas, ctx, exportView }
}

/** i コマ目(time 秒)を描く。デコードした絵がある動画は、video 要素の代わりにそれを使う */
async function paintFrame(ctx, exportView, time, i, readers) {
  const tracks = []
  for (const track of exportView.tracks) {
    if (track.type !== 'bg' || track.kind !== 'video' || !track.el) {
      tracks.push(track)
      continue
    }
    const reader = readers?.get(track.id)
    if (reader) {
      const frame = await reader.at(i)
      tracks.push(frame ? { ...track, el: frame } : track)
      continue
    }
    const clip = activeClip(track, time)
    if (clip) await seekVideo(track.el, bgSourceTime(track, clip, time))
    tracks.push(track)
  }
  composite(ctx, { ...exportView, tracks }, time)
}

async function mixAudio(view, duration, volume) {
  const bgBuffers = await decodeBgAudio(view.tracks)
  const mixed = await mixProjectAudio({
    tracks: view.tracks,
    bgBuffers,
    duration,
    volume,
  })
  if (!mixed || !bufferHasSignal(mixed)) return null
  return mixed
}

/**
 * WebCodecs が使えるブラウザ向け。フレームをオフラインで H.264 に載せて MP4 にする。
 */
async function exportWithWebCodecs({ view, duration, fps, volume, signal, onProgress }) {
  const ok = await canEncodeVideo('avc', {
    width: evenSize(view.width),
    height: evenSize(view.height),
    quality: QUALITY_HIGH,
  })
  if (!ok) throw new Error('no-webcodecs')

  const { canvas, ctx, exportView } = await prepareCanvas(view)
  const total = Math.max(1, Math.round(duration * fps))
  const dt = 1 / fps
  const audio = await mixAudio(view, duration, volume)
  const wantAac = audio && (await canEncodeAudio('aac'))

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: QUALITY_HIGH,
  })
  output.addVideoTrack(videoSource, { frameRate: fps })

  let audioSource = null
  if (wantAac) {
    audioSource = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH })
    output.addAudioTrack(audioSource)
  }

  await output.start()

  const readers = await frameReaders(exportView, total, dt, duration)
  try {
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal)
      const t = Math.min(duration, i * dt)
      await paintFrame(ctx, exportView, t, i, readers)
      await videoSource.add(t, dt, { keyFrame: i % (fps * 2) === 0 })
      if (i % 2 === 0 || i === total - 1) {
        onProgress?.(i + 1, total, '映像をエンコード中…')
      }
    }
  } finally {
    await closeReaders(readers)
  }

  if (audioSource && audio) {
    onProgress?.(total, total, '音声を載せてます…')
    await audioSource.add(audio)
  }

  throwIfAborted(signal)
  await output.finalize()
  return new Blob([output.target.buffer], { type: 'video/mp4' })
}

/**
 * Safari / iPad 向け。MediaRecorder で mp4（だめなら webm）を録る。
 * requestFrame があればオフライン相当、なければ実時間で進める。
 */
async function exportWithRecorder({ view, duration, fps, volume, signal, onProgress }) {
  const mime = pickRecorderMime()
  if (!mime) throw new Error('このブラウザでは動画の書き出しに対応していません')

  const { canvas, ctx, exportView } = await prepareCanvas(view)
  const total = Math.max(1, Math.round(duration * fps))
  const dt = 1 / fps
  const audio = await mixAudio(view, duration, volume)
  const readers = await frameReaders(exportView, total, dt, duration)

  await paintFrame(ctx, exportView, 0, 0, readers)

  const stream = canvas.captureStream(0)
  const videoTrack = stream.getVideoTracks()[0]
  const canRequest = typeof videoTrack?.requestFrame === 'function'

  let audioCtx = null
  if (audio) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    audioCtx = new Ctor()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    const dest = audioCtx.createMediaStreamDestination()
    const src = audioCtx.createBufferSource()
    src.buffer = audio
    const silent = audioCtx.createGain()
    silent.gain.value = 0
    src.connect(dest)
    src.connect(silent)
    silent.connect(audioCtx.destination)
    const atrack = dest.stream.getAudioTracks()[0]
    if (atrack) stream.addTrack(atrack)
    src.start(0)
  }

  const chunks = []
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: Math.min(8_000_000, Math.max(1_500_000, exportView.width * exportView.height * 4)),
  })
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }

  const stopped = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mime }))
    rec.onerror = () => reject(rec.error || new Error('録画に失敗しました'))
  })

  rec.start(200)
  const startedAt = performance.now()

  try {
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal)
      const t = Math.min(duration, i * dt)
      // 0 コマ目は録り始める前に描いてある
      if (i > 0) await paintFrame(ctx, exportView, t, i, readers)
      videoTrack?.requestFrame?.()
      onProgress?.(i + 1, total, '映像を録画中…')
      if (canRequest) {
        await sleep(0)
      } else {
        const wait = startedAt + (i + 1) * dt * 1000 - performance.now()
        if (wait > 0) await sleep(wait)
      }
    }
    if (!canRequest) {
      const tail = startedAt + duration * 1000 - performance.now()
      if (tail > 0) await sleep(tail)
    } else {
      await sleep(120)
    }
  } finally {
    if (rec.state !== 'inactive') rec.stop()
    await closeReaders(readers)
    await audioCtx?.close?.()
    stream.getTracks().forEach((tr) => tr.stop())
  }

  throwIfAborted(signal)
  return stopped
}

/**
 * 編集結果（背景 + セル + 音声）を 1 本の動画ファイルにする。
 * 可能なら MP4、さもなくばブラウザが扱える形式。
 */
export async function exportComposedVideo({ view, duration, fps, volume = 1, signal, onProgress }) {
  const dur = Math.max(1 / Math.max(1, fps), duration)
  // 書き出し中はプレビュー用の再生を止め、音は mix 側から載せる
  for (const track of view.tracks) {
    if (track.type === 'bg' && track.kind === 'video' && track.el) {
      track.el.pause()
      track.el.muted = true
    }
  }

  try {
    return await exportWithWebCodecs({
      view,
      duration: dur,
      fps,
      volume,
      signal,
      onProgress,
    })
  } catch (e) {
    if (e?.name === 'AbortError') throw e
    return exportWithRecorder({
      view,
      duration: dur,
      fps,
      volume,
      signal,
      onProgress,
    })
  }
}
