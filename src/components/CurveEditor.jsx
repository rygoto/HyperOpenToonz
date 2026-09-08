import { useCallback, useEffect, useRef, useState } from 'react'
import { LINEAR_CURVE, buildLut } from '../engine/fx.js'

const SIZE = 256
const PAD = 10
const HIT = 16

const CHANNELS = [
  { key: 'rgb', label: 'RGB', color: '#e6e6ea' },
  { key: 'r', label: 'R', color: '#ff6b6b' },
  { key: 'g', label: 'G', color: '#6bdd8a' },
  { key: 'b', label: 'B', color: '#6ba8ff' },
]

/** 制御点(正規化 0..1, y は上が 1)→ キャンバス座標 */
const toPx = (p) => ({
  x: PAD + p[0] * (SIZE - PAD * 2),
  y: SIZE - PAD - p[1] * (SIZE - PAD * 2),
})

const toNorm = (x, y) => [
  Math.min(1, Math.max(0, (x - PAD) / (SIZE - PAD * 2))),
  Math.min(1, Math.max(0, (SIZE - PAD - y) / (SIZE - PAD * 2))),
]

const clamp01 = (v) => Math.min(1, Math.max(0, v))

function capture(e) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    /* 掴めなくても pointermove は届く */
  }
}

export const CURVE_PRESETS = [
  { name: 'リニア', points: [[0, 0], [1, 1]] },
  { name: 'S字', points: [[0, 0], [0.25, 0.17], [0.75, 0.83], [1, 1]] },
  { name: '明るく', points: [[0, 0], [0.35, 0.5], [1, 1]] },
  { name: '暗く', points: [[0, 0], [0.5, 0.35], [1, 1]] },
  { name: 'フィルム', points: [[0, 0.06], [0.3, 0.28], [0.75, 0.82], [1, 0.96]] },
]

/**
 * トーンカーブの編集。点をドラッグして動かし、線の上をタップで足す。
 * 描いている線は実際に適用する 256 段の変換表そのままなので、見た目と結果が一致する。
 */
export default function CurveEditor({ curve, onChange, onBeginEdit }) {
  const canvasRef = useRef(null)
  const [channel, setChannel] = useState('rgb')
  const [picked, setPicked] = useState(null)
  const drag = useRef(null)

  const points = curve?.[channel] ?? LINEAR_CURVE
  const meta = CHANNELS.find((c) => c.key === channel) ?? CHANNELS[0]

  // ---------- 描画 ----------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, SIZE, SIZE)

    ctx.fillStyle = '#15151a'
    ctx.fillRect(0, 0, SIZE, SIZE)

    // 4分割のグリッドと対角線
    ctx.strokeStyle = '#2e2e38'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const t = PAD + (i / 4) * (SIZE - PAD * 2)
      ctx.beginPath()
      ctx.moveTo(t, PAD)
      ctx.lineTo(t, SIZE - PAD)
      ctx.moveTo(PAD, t)
      ctx.lineTo(SIZE - PAD, t)
      ctx.stroke()
    }
    ctx.strokeStyle = '#3a3a46'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(PAD, SIZE - PAD)
    ctx.lineTo(SIZE - PAD, PAD)
    ctx.stroke()
    ctx.setLineDash([])

    // RGB を編集しているときは他チャンネルの形も薄く出す
    if (channel === 'rgb') {
      for (const ch of CHANNELS.slice(1)) {
        const lut = buildLut(curve?.[ch.key] ?? LINEAR_CURVE)
        strokeLut(ctx, lut, ch.color, 1, 0.35)
      }
    }
    strokeLut(ctx, buildLut(points), meta.color, 2, 1)

    for (let i = 0; i < points.length; i++) {
      const p = toPx(points[i])
      ctx.beginPath()
      ctx.arc(p.x, p.y, i === picked ? 6 : 4.5, 0, Math.PI * 2)
      ctx.fillStyle = i === picked ? '#ffb020' : '#15151a'
      ctx.fill()
      ctx.strokeStyle = i === picked ? '#ffb020' : meta.color
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }, [curve, points, channel, picked, meta.color])

  // ---------- 編集 ----------
  const local = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
      scale: rect.width / SIZE,
    }
  }

  const write = useCallback(
    (next) => {
      const sorted = [...next].sort((a, b) => a[0] - b[0])
      onChange({ ...curve, on: true, [channel]: sorted })
      return sorted
    },
    [channel, curve, onChange],
  )

  const onDown = (e) => {
    e.preventDefault()
    const { x, y, scale } = local(e)
    const hit = Math.max(HIT, HIT / Math.max(0.2, scale))

    let index = -1
    let best = Infinity
    for (let i = 0; i < points.length; i++) {
      const p = toPx(points[i])
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < best) {
        best = d
        index = i
      }
    }

    onBeginEdit?.()
    if (best > hit) {
      // 近くに点が無ければ足す。挿す場所はそのまま掴んだ点の位置になる
      const p = toNorm(x, y)
      index = points.findIndex((q) => q[0] > p[0])
      if (index < 0) index = points.length
      write([...points.slice(0, index), p, ...points.slice(index)])
    }
    setPicked(index)
    drag.current = { index }
    capture(e)
  }

  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const { x, y } = local(e)
    const [nx, ny] = toNorm(x, y)
    const last = points.length - 1
    // 両端は横に動かさない(0 と 255 の入力を必ず持たせる)
    const fixedX = d.index === 0 ? 0 : d.index === last ? 1 : null
    const lo = d.index > 0 ? points[d.index - 1][0] + 0.01 : 0
    const hi = d.index < last ? points[d.index + 1][0] - 0.01 : 1
    // 隣を追い越さないように詰めるので、並び順は動かない = index はそのまま使える
    const px = fixedX ?? clamp01(Math.min(Math.max(nx, lo), hi))
    write(points.map((p, i) => (i === d.index ? [px, ny] : p)))
  }

  const onUp = () => {
    drag.current = null
  }

  const removePicked = () => {
    if (picked == null || picked <= 0 || picked >= points.length - 1) return
    onBeginEdit?.()
    write(points.filter((_, i) => i !== picked))
    setPicked(null)
  }

  const takePreset = (preset) => {
    onBeginEdit?.()
    write(preset.points.map((p) => [...p]))
    setPicked(null)
  }

  const resetAll = () => {
    onBeginEdit?.()
    onChange({
      ...curve,
      on: true,
      rgb: LINEAR_CURVE.map((p) => [...p]),
      r: LINEAR_CURVE.map((p) => [...p]),
      g: LINEAR_CURVE.map((p) => [...p]),
      b: LINEAR_CURVE.map((p) => [...p]),
    })
    setPicked(null)
  }

  return (
    <div className="curve">
      <div className="presets curve__tabs">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            className={channel === c.key ? 'is-active' : ''}
            style={channel === c.key ? { color: c.color, borderColor: c.color } : undefined}
            onClick={() => {
              setChannel(c.key)
              setPicked(null)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        className="curve__canvas"
        width={SIZE}
        height={SIZE}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />

      <div className="presets">
        {CURVE_PRESETS.map((p) => (
          <button key={p.name} onClick={() => takePreset(p)}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="row">
        <button disabled={picked == null || picked === 0 || picked === points.length - 1} onClick={removePicked}>
          選んだ点を消す
        </button>
        <button onClick={resetAll}>全チャンネル戻す</button>
      </div>
      <p className="hint">線の上をタップで点を追加、ドラッグで移動。両端の点は横に動きません。</p>
    </div>
  )
}

function strokeLut(ctx, lut, color, width, alpha) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  for (let v = 0; v < 256; v++) {
    const p = toPx([v / 255, lut[v] / 255])
    if (v === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  ctx.restore()
}
