import { useEffect, useRef, useState } from 'react'
import { composite } from '../engine/compositor.js'
import { filesFromDataTransfer } from '../engine/media.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 背景動画をタイムラインに追従させる。
 * タイムベースはあくまで clock 側。ズレが小さいうちは再生速度を微調整して
 * 吸収し、大きくズレたときだけシークする(シーク時の途切れを減らすため)。
 */
function syncVideo(el, bg, st) {
  const dur = bg.duration || 0
  const beyond = dur > 0 && st.time >= dur - 0.02

  if (!st.playing || beyond) {
    if (!el.paused) el.pause()
    const target = dur > 0 ? Math.min(st.time, dur) : st.time
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

  const drift = st.time - el.currentTime
  if (Math.abs(drift) > 0.3) {
    if (!el.seeking) {
      try {
        el.currentTime = st.time
      } catch {
        /* noop */
      }
    }
    el.playbackRate = st.rate
  } else {
    el.playbackRate = clamp(st.rate * (1 + drift * 0.5), st.rate * 0.94, st.rate * 1.06)
  }
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
    const bg = view.background
    if (!host || !bg || bg.kind !== 'video') return
    host.appendChild(bg.el)
    return () => {
      if (bg.el.parentNode === host) host.removeChild(bg.el)
    }
  }, [view.background])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let raf = 0
    let last = performance.now()

    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now

      clock.advance(dt)
      const st = clock.peek()
      const v = viewRef.current
      const volume = v.muted ? 0 : v.volume

      const bg = v.background
      if (bg && bg.kind === 'video') {
        bg.el.muted = v.muted
        bg.el.volume = v.volume
        syncVideo(bg.el, bg, st)
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
