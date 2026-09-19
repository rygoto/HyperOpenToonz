import { useEffect, useRef, useState } from 'react'
import { composite, placeRect, trackDeg, trackRectAt } from '../engine/compositor.js'
import { filesFromDataTransfer } from '../engine/media.js'
import { activeClip, bgSourceTime, isVisual } from '../engine/timeline.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const MIN_SCALE = 0.02
const MAX_SCALE = 20
const SNAP_DEG = 15

/** 角度は -180〜180 に畳んでおく(数値と行き来しても増え続けない) */
const wrapDeg = (deg) => {
  let v = deg % 360
  if (v > 180) v -= 360
  if (v <= -180) v += 360
  return Math.round(v * 10) / 10
}

/** b から見た a の向き(度) */
const degOf = (a, b) => (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI

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
  // 音声を取り出してある動画(音声付加側)は Web Audio が鳴らすので、要素は黙らせる
  el.muted = muted || !!track.muted || !!track.buffer
  el.volume = clamp(volume * (track.gain ?? 1), 0, 1)
  const clip = activeClip(track, st.time)
  if (!clip) {
    if (!el.paused) el.pause()
    return
  }
  syncVideo(el, bgSourceTime(track, clip, st.time), st.playing, st.rate)
}

const HANDLES = ['nw', 'ne', 'sw', 'se']

/** ドラッグ中もこの要素にイベントを届かせる。掴めない環境では黙って諦める */
function capture(e) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    /* 掴めなくても pointermove は届く */
  }
}

export default function Stage({
  clock,
  audio,
  view,
  onDropFiles,
  grab,
  onGrab,
  grabTrackId,
  onGrabTrack,
  onBeginEdit,
  onPatchTrack,
  canGrab = true,
}) {
  const canvasRef = useRef(null)
  const hostRef = useRef(null)
  const stageRef = useRef(null)
  const boxRef = useRef(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const [dragging, setDragging] = useState(false)

  // 直接操作の状態はレンダーを挟まずに読み書きする
  const grabRef = useRef({ on: grab, trackId: grabTrackId })
  grabRef.current = { on: grab, trackId: grabTrackId }
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const lastWheel = useRef(0)

  const layers = view.tracks.filter(isVisual)
  const target = layers.find((t) => t.id === grabTrackId) ?? null

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
    let parked = false

    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const v = viewRef.current

      // もう一方のアプリを開いている間は、音も映像も止めて何も描かない
      if (v.asleep) {
        if (!parked) {
          parked = true
          audio.sync({ playing: false, time: 0, rate: 1, tracks: v.tracks, volume: 0 })
          for (const track of v.tracks) track.el?.pause?.()
        }
        last = now
        return
      }
      parked = false
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
      layoutBox()
    }

    // 選択枠はキャンバスに焼かず DOM で重ねる(書き出しに映り込まないように)
    const layoutBox = () => {
      const box = boxRef.current
      if (!box) return
      const v = viewRef.current
      const g = grabRef.current
      const track = g.on ? v.tracks.find((t) => t.id === g.trackId) : null
      if (!track || !isVisual(track) || !(track.width > 0)) {
        box.style.display = 'none'
        return
      }
      const cr = canvas.getBoundingClientRect()
      const sr = stageRef.current.getBoundingClientRect()
      const s = cr.width / (v.width || 1)
      const r = placeRect(track, track.width, track.height, v.width, v.height)
      const deg = trackDeg(track)
      box.style.display = 'block'
      box.style.left = cr.left - sr.left + r.x * s + 'px'
      box.style.top = cr.top - sr.top + r.y * s + 'px'
      box.style.width = r.w * s + 'px'
      box.style.height = r.h * s + 'px'
      // 枠も絵と同じ角度で回す(軸は枠の中心 = 絵の中心)
      box.style.transform = deg ? 'rotate(' + deg + 'deg)' : ''
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

  /* ---------- 直接操作 ---------- */

  /** クライアント座標 → ステージ(キャンバス)座標と、表示倍率 */
  const stageSpace = (e) => {
    const canvas = canvasRef.current
    const cr = canvas.getBoundingClientRect()
    const s = cr.width / (view.width || 1)
    return { x: (e.clientX - cr.left) / s, y: (e.clientY - cr.top) / s, s }
  }

  const patch = (patchObj) => {
    const id = gesture.current?.trackId
    if (id) onPatchTrack(id, patchObj)
  }

  const baseOf = (track) => ({ x: track.x, y: track.y, scale: track.scale, rotate: trackDeg(track) })

  /** 絵の中心。拡縮も回転もここを軸にする */
  const centerOf = (track) => {
    const r = placeRect(track, track.width, track.height, view.width, view.height)
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  }

  const startMove = (track, pointer) => {
    gesture.current = {
      mode: 'move',
      trackId: track.id,
      from: { x: pointer.x, y: pointer.y },
      base: baseOf(track),
    }
  }

  const startPinch = (track) => {
    const [a, b] = [...pointers.current.values()]
    gesture.current = {
      mode: 'pinch',
      trackId: track.id,
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      deg: degOf(b, a),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      base: baseOf(track),
    }
  }

  const onGrabDown = (e) => {
    if (!grab) return
    const p = stageSpace(e)
    pointers.current.set(e.pointerId, p)
    capture(e)
    e.preventDefault()

    if (pointers.current.size >= 2) {
      const track = view.tracks.find((t) => t.id === grabRef.current.trackId)
      if (track) {
        onBeginEdit?.()
        startPinch(track)
      }
      return
    }

    // 1本目: 触った場所にあるレイヤーへ持ち替える
    const hit = trackRectAt(view.tracks, view.width, view.height, p.x, p.y)
    const track = hit?.track ?? target
    if (!track) return
    if (track.id !== grabTrackId) onGrabTrack(track.id)
    onBeginEdit?.()
    startMove(track, p)
  }

  const onGrabMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, stageSpace(e))
    const g = gesture.current
    if (!g) return

    // 2本指: 広げて拡縮、ひねって回転、動かして移動
    if (g.mode === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      patch({
        scale: clamp((g.base.scale * dist) / g.dist, MIN_SCALE, MAX_SCALE),
        rotate: wrapDeg(g.base.rotate + (degOf(b, a) - g.deg)),
        x: g.base.x + (mid.x - g.mid.x),
        y: g.base.y + (mid.y - g.mid.y),
      })
      return
    }

    if (g.mode === 'move') {
      const p = pointers.current.get(e.pointerId)
      patch({ x: g.base.x + (p.x - g.from.x), y: g.base.y + (p.y - g.from.y) })
      return
    }

    if (g.mode === 'scale') {
      const p = pointers.current.get(e.pointerId)
      const dist = Math.max(1, Math.hypot(p.x - g.center.x, p.y - g.center.y))
      patch({ scale: clamp((g.base.scale * dist) / g.dist, MIN_SCALE, MAX_SCALE) })
      return
    }

    if (g.mode === 'rotate') {
      const p = pointers.current.get(e.pointerId)
      let deg = g.base.rotate + (degOf(p, g.center) - g.deg)
      if (e.shiftKey) deg = Math.round(deg / SNAP_DEG) * SNAP_DEG
      patch({ rotate: wrapDeg(deg) })
    }
  }

  const onGrabUp = (e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) {
      gesture.current = null
      return
    }
    // ピンチから指が1本になったら、残った指で移動を続ける
    const track = view.tracks.find((t) => t.id === gesture.current?.trackId)
    if (track) startMove(track, [...pointers.current.values()][0])
  }

  const onHandleDown = (e) => {
    if (!target) return
    e.stopPropagation()
    e.preventDefault()
    const p = stageSpace(e)
    const center = centerOf(target)
    onBeginEdit?.()
    gesture.current = {
      mode: 'scale',
      trackId: target.id,
      center,
      dist: Math.max(1, Math.hypot(p.x - center.x, p.y - center.y)),
      base: baseOf(target),
    }
    pointers.current.set(e.pointerId, p)
    capture(e)
  }

  /** 枠の上に出るノブ。中心まわりの角度をそのまま角度にする */
  const onRotateDown = (e) => {
    if (!target) return
    e.stopPropagation()
    e.preventDefault()
    const p = stageSpace(e)
    const center = centerOf(target)
    onBeginEdit?.()
    gesture.current = {
      mode: 'rotate',
      trackId: target.id,
      center,
      deg: degOf(p, center),
      base: baseOf(target),
    }
    pointers.current.set(e.pointerId, p)
    capture(e)
  }

  const onWheel = (e) => {
    if (!grab || !target) return
    e.preventDefault()
    const now = performance.now()
    if (now - lastWheel.current > 400) onBeginEdit?.()
    lastWheel.current = now
    // Shift を押しながらなら回転、そうでなければ拡縮
    if (e.shiftKey) {
      onPatchTrack(target.id, { rotate: wrapDeg(trackDeg(target) + e.deltaY * 0.12) })
      return
    }
    const next = clamp(target.scale * (1 - e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE)
    onPatchTrack(target.id, { scale: next })
  }

  const reset = () => {
    if (!target) return
    onBeginEdit?.()
    onPatchTrack(target.id, { scale: 1, x: 0, y: 0, rotate: 0 })
  }

  const straighten = () => {
    if (!target) return
    onBeginEdit?.()
    onPatchTrack(target.id, { rotate: 0 })
  }

  return (
    <div
      className={'stage' + (dragging ? ' stage--drop' : '')}
      ref={stageRef}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <canvas ref={canvasRef} className="stage__canvas" />
      <div ref={hostRef} className="stage__media-host" />

      {grab && (
        <div
          className="stage__grab"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
          onWheel={onWheel}
        />
      )}

      <div ref={boxRef} className="stage__box" style={{ display: 'none' }}>
        {/* つまんだ間はポインタがハンドル側に捕まるので、続きもここで受ける */}
        {HANDLES.map((h) => (
          <span
            key={h}
            className={'stage__handle stage__handle--' + h}
            onPointerDown={onHandleDown}
            onPointerMove={onGrabMove}
            onPointerUp={onGrabUp}
            onPointerCancel={onGrabUp}
          />
        ))}
        <span
          className="stage__rot"
          title="ドラッグで回転(Shift で15度ずつ)"
          onPointerDown={onRotateDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
        />
      </div>

      <div className="stage__tools">
        {canGrab && (
          <button className={grab ? 'primary' : ''} onClick={() => onGrab(!grab)} title="ステージ上で直接動かす">
            ✥ 直接操作
          </button>
        )}
        {grab && (
          <>
            <select
              value={grabTrackId ?? ''}
              onChange={(e) => onGrabTrack(e.target.value || null)}
              aria-label="動かすレイヤー"
            >
              <option value="">レイヤーを選ぶ</option>
              {layers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {target && (
              <>
                <span className="mono dim">
                  {Math.round(target.scale * 100)}% / {Math.round(target.x)},{Math.round(target.y)} /{' '}
                  {Math.round(trackDeg(target))}°
                </span>
                {trackDeg(target) !== 0 && <button onClick={straighten}>回転を戻す</button>}
                <button onClick={reset}>リセット</button>
              </>
            )}
          </>
        )}
      </div>

      {grab && (
        <p className="stage__grabhint">
          {target
            ? 'ドラッグで移動、角をつまむ / ピンチ / ホイールで拡縮、上のノブ / 2本指ひねり / Shift+ホイールで回転'
            : '動かしたいレイヤーをステージで触るか、上で選んでください'}
        </p>
      )}

      {dragging && <div className="stage__hint">ドロップして読み込み</div>}
    </div>
  )
}
