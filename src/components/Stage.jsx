import { useEffect, useRef, useState } from 'react'
import { composite } from '../engine/compositor.js'
import { filesFromDataTransfer } from '../engine/media.js'
import { activeClip, bgSourceTime } from '../engine/timeline.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 背景動画をタイムラインに追従させる。
 * タイムベースはあくまで clock 側。ズレが小さいうちは再生速度を微調整して
 * 吸収し、大きくズレたときだけシークする(シーク時の途切れを減らすため)。
 */
function syncVideo(el, target, playing, rate) {
  if (!playing) {
    if (!el.paused) el.pause()
    if (!el.seeking && Math.abs(el.currentTime - target) > 0.02) {
      try {
        el.currentTime = target
      } catch {
        /* シーク不可のフォーマットは無視 */
      }
    }
    return
  }

  if (el.paused && el.readyState >= 2) {
    el.play().catch(() => {})
  }

  const drift = target - el.currentTime
  if (Math.abs(drift) > 0.3) {
    if (!el.seeking) {
      try {
        el.currentTime = target
      } catch {
        /* noop */
      }
    }
    el.playbackRate = rate
  } else {
    el.playbackRate = clamp(rate * (1 + drift * 0.5), rate * 0.94, rate * 1.06)
  }
}

/** 背景トラック1本ぶんの追従。クリップの外では止めておく */
function syncBgTrack(track, st, muted, volume) {
  const el = track.el
  if (!el) return
  el.muted = muted || !!track.muted
  el.volume = volume
  const clip = activeClip(track, st.time)
  if (!clip) {
    if (!el.paused) el.pause()
    return
  }
  syncVideo(el, bgSourceTime(track, clip, st.time), st.playing, st.rate)
}

export default function Stage({ clock, audio, view, onDropFiles }) {
  const canvasRef = useRef(null)
  const hostRef = useRef(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const [dragging, setDragging] = useState(false)

  // 背景動画の要素を DOM に置く(デコード・音声再生を確実にするため)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const els = view.tracks
      .filter((t) => t.type === 'bg' && t.kind === 'video' && t.el)
      .map((t) => t.el)
    for (const el of els) {
      if (el.parentNode !== host) host.appendChild(el)
    }
    // 消えたトラックの映像は止めて外す
    for (const child of [...host.children]) {
      if (!els.includes(child)) {
        child.pause?.()
        host.removeChild(child)
      }
    }
  }, [view.tracks])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let raf = 0
    let last = performance.now()

    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const v = viewRef.current
      if (v.frozen) return

      const dt = Math.min(0.25, (now - last) / 1000)
      last = now

      clock.advance(dt)
      const st = clock.peek()
      const volume = v.muted ? 0 : v.volume

      for (const track of v.tracks) {
        if (track.type === 'bg' && track.kind === 'video') {
          syncBgTrack(track, st, v.muted, v.volume)
        }
      }

      audio.sync({
        playing: st.playing,
        time: st.time,
        rate: st.rate,
        tracks: v.tracks,
        volume,
      })

      if (canvas.width !== v.width || canvas.height !== v.height) {
        canvas.width = v.width
        canvas.height = v.height
      }
      composite(ctx, v, st.time)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [clock, audio])

  const onDrop = async (e) => {
    e.preventDefault()
    setDragging(false)
    const files = await filesFromDataTransfer(e.dataTransfer)
    if (files.length) onDropFiles(files)
  }

  return (
    <div
      className={'stage' + (dragging ? ' stage--drop' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <canvas ref={canvasRef} className="stage__canvas" />
      <div ref={hostRef} className="stage__media-host" />
      {dragging && <div className="stage__hint">ドロップして読み込み</div>}
    </div>
  )
}
