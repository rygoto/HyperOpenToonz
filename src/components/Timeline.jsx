import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  clipEndSec,
  clipLenSec,
  isVisual,
  sortClips,
  trackFps,
  trimClipEnd,
  trimClipStart,
} from '../engine/timeline.js'
import { useMatchMedia } from '../hooks/useMatchMedia.js'

const RULER_H = 22
const SNAP_PX = 8
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

function tickStep(pxPerSec) {
  return STEPS.find((s) => s * pxPerSec >= 70) ?? 1200
}

function fmtTick(t) {
  const m = Math.floor(t / 60)
  const s = t % 60
  const sec = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(2).padStart(5, '0')
  return `${m}:${sec}`
}

/** 音声クリップの波形 */
function Wave({ track, clip, width }) {
  const ref = useRef(null)
  const w = Math.min(4000, Math.max(1, Math.round(width)))

  useEffect(() => {
    const cv = ref.current
    if (!cv || !track.peaks) return
    const h = 20
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(190, 235, 255, 0.8)'
    const n = track.peaks.length
    for (let x = 0; x < w; x++) {
      const srcSec = clip.in + (x / w) * clip.len
      const i = Math.min(n - 1, Math.max(0, Math.floor((srcSec / track.duration) * n)))
      const bar = Math.max(1, track.peaks[i] * h)
      ctx.fillRect(x, (h - bar) / 2, 1, bar)
    }
  }, [track.peaks, track.duration, clip.in, clip.len, w])

  return <canvas ref={ref} className="clip__wave" />
}

function ClipView({ track, clip, pxPerSec, selected, onGrab }) {
  const lenSec = clipLenSec(track, clip)
  const left = clip.start * pxPerSec
  const width = Math.max(3, lenSec * pxPerSec)
  const isCellTrack = track.type === 'cell'
  const framePx = isCellTrack ? pxPerSec / trackFps(track) : 0
  const showTicks = isCellTrack && framePx >= 4

  return (
    <div
      className={
        'clip clip--' + track.type + (selected ? ' is-selected' : '') +
        (isVisual(track) && !track.visible ? ' is-off' : '') +
        (track.type === 'audio' && track.muted ? ' is-off' : '')
      }
      style={{
        left,
        width,
        backgroundSize: showTicks ? `${framePx}px 100%` : undefined,
        backgroundImage: showTicks
          ? 'repeating-linear-gradient(90deg, rgba(255,255,255,0.22) 0 1px, transparent 1px 100%)'
          : undefined,
      }}
      onPointerDown={(e) => onGrab(e, track, clip, 'move')}
    >
      <div
        className="clip__trim clip__trim--l"
        onPointerDown={(e) => onGrab(e, track, clip, 'trim-start')}
      />
      {track.type === 'audio' && width > 8 && <Wave track={track} clip={clip} width={width} />}
      <span className="clip__label">
        {isCellTrack
          ? `${Math.round(clip.in) + 1}〜${Math.round(clip.in + clip.len)}コマ`
          : `${lenSec.toFixed(2)}s`}
      </span>
      <div
        className="clip__trim clip__trim--r"
        onPointerDown={(e) => onGrab(e, track, clip, 'trim-end')}
      />
    </div>
  )
}

export default function Timeline({
  ref,
  clock,
  tracks,
  projectFps,
  selection,
  onSelection,
  onBeginEdit,
  onTracksChange,
  onTrackPatch,
}) {
  const st = useSyncExternalStore(clock.subscribe, clock.getSnapshot)
  const coarse = useMatchMedia('(pointer: coarse)')
  const ROW_H = coarse ? 44 : 30
  const [pxPerSec, setPxPerSec] = useState(90)
  const [viewport, setViewport] = useState({ left: 0, width: 800 })
  const scrollRef = useRef(null)
  const contentRef = useRef(null)
  const drag = useRef(null)
  const pointers = useRef(new Map())
  const pinch = useRef(null)
  const pxRef = useRef(90)

  useEffect(() => {
    pxRef.current = pxPerSec
  }, [pxPerSec])

  useEffect(() => {
    const up = (e) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size < 2) pinch.current = null
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  const lengthSec = Math.max(st.duration, 8) + 4
  const contentW = lengthSec * pxPerSec
  const gridPx = tickStep(pxPerSec) * pxPerSec

  const timeAt = (clientX) => {
    const rect = contentRef.current.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left) / pxPerSec)
  }

  // ---- スクロール位置の把握(目盛りを見えている範囲だけ描くため) ----
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const read = () => setViewport({ left: el.scrollLeft, width: el.clientWidth })
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [])

  // ---- 再生ヘッドを視界に保つ ----
  useEffect(() => {
    if (!st.playing) return
    const el = scrollRef.current
    if (!el) return
    const x = st.time * pxPerSec
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.25)
    }
  }, [st.time, st.playing, pxPerSec])

  const ticks = useMemo(() => {
    const step = tickStep(pxPerSec)
    const from = Math.floor(viewport.left / pxPerSec / step) * step
    const to = (viewport.left + viewport.width) / pxPerSec + step
    const out = []
    for (let t = from; t <= Math.min(to, lengthSec); t += step) {
      if (t >= 0) out.push(Number(t.toFixed(4)))
    }
    return out
  }, [pxPerSec, viewport, lengthSec])

  // ---- スナップ候補 ----
  const snapPoints = (excludeIds) => {
    const pts = [0, st.time]
    for (const tr of tracks) {
      for (const c of tr.clips) {
        if (excludeIds.includes(c.id)) continue
        pts.push(c.start, clipEndSec(tr, c))
      }
    }
    return pts
  }

  const snapValue = (t, points) => {
    const thr = SNAP_PX / pxPerSec
    let best = null
    let bestD = thr
    for (const p of points) {
      const d = Math.abs(p - t)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    if (best != null) return best
    return Math.round(t * projectFps) / projectFps
  }

  // ---- クリップ操作 ----
  const onGrab = (e, track, clip, mode) => {
    if (e.button !== 0) return
    if (pinch.current) return
    e.stopPropagation()
    e.preventDefault()

    let ids = selection
    if (mode !== 'move') {
      ids = [clip.id]
      onSelection(ids)
    } else if (!selection.includes(clip.id)) {
      ids = e.shiftKey ? [...selection, clip.id] : [clip.id]
      onSelection(ids)
    } else if (e.shiftKey) {
      onSelection(selection.filter((i) => i !== clip.id))
      return
    }

    const edges = []
    for (const tr of tracks) {
      for (const c of tr.clips) {
        if (ids.includes(c.id)) edges.push(c.start, clipEndSec(tr, c))
      }
    }

    drag.current = {
      mode,
      ids,
      began: false,
      trackId: track.id,
      clipId: clip.id,
      grabTime: timeAt(e.clientX),
      base: tracks,
      edges,
      primaryStart: clip.start,
      minStart: Math.min(...tracks.flatMap((tr) => tr.clips.filter((c) => ids.includes(c.id)).map((c) => c.start))),
      snaps: snapPoints(ids),
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onDragMove = (e) => {
    const d = drag.current
    if (!d) return
    const t = timeAt(e.clientX)

    if (d.mode === 'move') {
      let delta = t - d.grabTime
      const thr = SNAP_PX / pxPerSec
      let best = null
      let bestD = thr
      for (const edge of d.edges) {
        for (const s of d.snaps) {
          const diff = s - (edge + delta)
          if (Math.abs(diff) < bestD) {
            bestD = Math.abs(diff)
            best = delta + diff
          }
        }
      }
      if (best != null) {
        delta = best
      } else {
        const snapped = Math.round((d.primaryStart + delta) * projectFps) / projectFps
        delta = snapped - d.primaryStart
      }
      delta = Math.max(delta, -d.minStart)
      if (!d.began && Math.abs(delta) < 1e-9) return
      if (!d.began) {
        d.began = true
        onBeginEdit()
      }

      onTracksChange(
        d.base.map((tr) =>
          tr.clips.some((c) => d.ids.includes(c.id))
            ? {
                ...tr,
                clips: sortClips(
                  tr.clips.map((c) =>
                    d.ids.includes(c.id) ? { ...c, start: Math.max(0, c.start + delta) } : c,
                  ),
                ),
              }
            : tr,
        ),
      )
      return
    }

    const tr = d.base.find((x) => x.id === d.trackId)
    const clip = tr?.clips.find((c) => c.id === d.clipId)
    if (!clip) return
    const at = snapValue(t, d.snaps)
    const next = d.mode === 'trim-start' ? trimClipStart(tr, clip, at) : trimClipEnd(tr, clip, at)
    if (next.start === clip.start && next.len === clip.len) return
    if (!d.began) {
      d.began = true
      onBeginEdit()
    }
    onTracksChange(
      d.base.map((x) =>
        x.id === tr.id
          ? { ...x, clips: sortClips(x.clips.map((c) => (c.id === clip.id ? next : c))) }
          : x,
      ),
    )
  }

  const endDrag = () => {
    drag.current = null
  }

  // ---- 空き部分のクリック / ルーラーのドラッグでシーク ----
  const scrub = (e) => {
    clock.seek(Math.round(timeAt(e.clientX) * projectFps) / projectFps)
  }

  const onSurfaceDown = (e) => {
    if (e.button !== 0) return
    if (pinch.current || pointers.current.size > 1) return
    if (!coarse) e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode: 'scrub' }
    clock.pause()
    scrub(e)
    onSelection([])
  }

  const onSurfaceMove = (e) => {
    if (drag.current?.mode === 'scrub') scrub(e)
  }

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const el = scrollRef.current
    const anchor = (el.scrollLeft + e.clientX - el.getBoundingClientRect().left) / pxPerSec
    const next = Math.min(2000, Math.max(6, pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    setPxPerSec(next)
    requestAnimationFrame(() => {
      el.scrollLeft = anchor * next - (e.clientX - el.getBoundingClientRect().left)
    })
  }

  const pinchDist = () => {
    const pts = [...pointers.current.values()]
    if (pts.length < 2) return 0
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
  }

  const onPinchPointerDown = (e) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      pinch.current = { dist: pinchDist(), px: pxRef.current }
      drag.current = null
    }
  }

  const onPinchPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (!pinch.current || pointers.current.size < 2) return
    const d = pinchDist()
    if (d < 8) return
    const next = Math.min(2000, Math.max(6, pinch.current.px * (d / pinch.current.dist)))
    setPxPerSec(next)
  }

  const onPinchPointerUp = (e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  const rows = tracks.length

  return (
    <div className="tl" ref={ref}>
      <div className="tl__toolbar">
        <span className="tl__hint dim">
          {coarse
            ? 'タップで選択 / ドラッグで移動・トリム / ピンチで拡大'
            : 'クリックで選択 / ドラッグで移動 / 端をドラッグでトリム ・ Ctrl+B 分割 ・ Ctrl+X/C/V ・ Del 削除 ・ Ctrl+Z 戻す'}
        </span>
        <div className="tl__zoom">
          <button onClick={() => setPxPerSec((p) => Math.max(6, p / 1.4))} title="縮小">−</button>
          <span className="mono dim">{Math.round(pxPerSec)}px/s</span>
          <button onClick={() => setPxPerSec((p) => Math.min(2000, p * 1.4))} title="拡大">＋</button>
          <button
            title="全体を表示"
            onClick={() => {
              const el = scrollRef.current
              if (el) setPxPerSec(Math.max(6, (el.clientWidth - 8) / Math.max(1, lengthSec)))
            }}
          >
            全体
          </button>
        </div>
      </div>

      <div className="tl__body">
        <div className="tl__headers" style={{ height: RULER_H + rows * ROW_H }}>
          <div className="tl__corner" style={{ height: RULER_H }} />
          {tracks.map((tr) => (
            <div className="tl__th" style={{ height: ROW_H }} key={tr.id}>
              <button
                className={
                  'tl__th-toggle' + ((isVisual(tr) ? tr.visible : !tr.muted) ? '' : ' is-off')
                }
                title={isVisual(tr) ? '表示 / 非表示' : 'ミュート'}
                onClick={() => {
                  onBeginEdit()
                  onTrackPatch(tr.id, isVisual(tr) ? { visible: !tr.visible } : { muted: !tr.muted })
                }}
              >
                {isVisual(tr) ? (tr.visible ? '◉' : '◯') : tr.muted ? '🔇' : '🔊'}
              </button>
              <span className="tl__th-name" title={tr.name}>{tr.name}</span>
            </div>
          ))}
        </div>

        <div
          className="tl__scroll"
          ref={scrollRef}
          onWheel={onWheel}
          onPointerDown={onPinchPointerDown}
          onPointerMove={onPinchPointerMove}
          onPointerUp={onPinchPointerUp}
          onPointerCancel={onPinchPointerUp}
        >
          <div
            className="tl__content"
            ref={contentRef}
            style={{ width: contentW, height: RULER_H + rows * ROW_H }}
            onPointerDown={onSurfaceDown}
            onPointerMove={(e) => {
              onSurfaceMove(e)
              onDragMove(e)
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="tl__ruler" style={{ height: RULER_H }}>
              {ticks.map((t) => (
                <div className="tl__tick" style={{ left: t * pxPerSec }} key={t}>
                  <span>{fmtTick(t)}</span>
                </div>
              ))}
            </div>

            {tracks.map((tr) => (
              <div
                className="tl__row"
                style={{ height: ROW_H, backgroundSize: `${gridPx}px 100%` }}
                key={tr.id}
              >
                {tr.clips.map((c) => (
                  <ClipView
                    key={c.id}
                    track={tr}
                    clip={c}
                    pxPerSec={pxPerSec}
                    selected={selection.includes(c.id)}
                    onGrab={onGrab}
                  />
                ))}
              </div>
            ))}

            <div className="tl__playhead" style={{ left: st.time * pxPerSec }} />
          </div>
        </div>
      </div>
    </div>
  )
}
