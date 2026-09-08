/**
 * 撮影処理(コンポジット後処理)。
 *
 * アニメの撮影で使う工程を、レイヤー単位のパイプラインとして持つ。
 * 素材 → ぼかし → トーンカーブ → カラー合成 → 光源 → グロー(ブルーム)
 *
 * 効果は「素材の解像度」で焼き込むので、ステージの大きさを変えても
 * プレビューと書き出しで同じ絵になる。セルは1コマずつ結果をキャッシュするので、
 * 再生中は同じコマを作り直さない。
 */

export const LIGHT_BLENDS = ['screen', 'lighter', 'overlay', 'soft-light', 'multiply']
export const GRADE_BLENDS = ['screen', 'multiply', 'overlay', 'soft-light', 'lighter', 'color']

/** 焼き込んだコマを溜めておく上限(だいたい 192MB ぶん) */
const CACHE_BYTES = 192 * 1024 * 1024

export const LINEAR_CURVE = [
  [0, 0],
  [1, 1],
]

const linear = () => LINEAR_CURVE.map((p) => [...p])

export function defaultFx() {
  return {
    enabled: true,
    blur: { on: false, radius: 6 },
    curve: { on: false, rgb: linear(), r: linear(), g: linear(), b: linear() },
    grade: { on: false, color: '#ff9c47', blend: 'screen', amount: 0.28 },
    light: {
      on: false,
      color: '#ffd9a0',
      blend: 'screen',
      amount: 0.55,
      shape: 'radial',
      x: 0.3,
      y: 0.22,
      radius: 0.9,
      angle: 90,
      pos: 0.6,
      soft: 0.7,
    },
    bloom: { on: false, amount: 0.6, radius: 14, threshold: 0.62 },
  }
}

/** 欠けているところを既定値で埋める(古い形のデータ・素材追加時の共通化用) */
export function normalizeFx(fx) {
  const base = defaultFx()
  if (!fx) return base
  return {
    enabled: fx.enabled !== false,
    blur: { ...base.blur, ...fx.blur },
    curve: { ...base.curve, ...fx.curve },
    grade: { ...base.grade, ...fx.grade },
    light: { ...base.light, ...fx.light },
    bloom: { ...base.bloom, ...fx.bloom },
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/* ---------------- トーンカーブ ---------------- */

/**
 * 制御点から 256 段の変換表を作る。
 * 単調エルミート補間(Fritsch-Carlson)なので、点の間で行き過ぎて波打たない。
 */
export function buildLut(points) {
  const lut = new Uint8Array(256)
  const pts = [...(points ?? [])]
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .sort((a, b) => a[0] - b[0])
  if (pts.length < 2) {
    for (let v = 0; v < 256; v++) lut[v] = v
    return lut
  }
  const n = pts.length
  const xs = pts.map((p) => clamp01(p[0]))
  const ys = pts.map((p) => clamp01(p[1]))

  const d = new Array(n - 1)
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i])

  const m = new Array(n)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2

  // 単調性が崩れない範囲まで傾きを詰める
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }

  let i = 0
  for (let v = 0; v < 256; v++) {
    const x = v / 255
    while (i < n - 2 && x > xs[i + 1]) i++
    const h = Math.max(1e-6, xs[i + 1] - xs[i])
    const t = clamp01((x - xs[i]) / h)
    const t2 = t * t
    const t3 = t2 * t
    const y =
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    lut[v] = Math.max(0, Math.min(255, Math.round(y * 255)))
  }
  return lut
}

export function isIdentityLut(lut) {
  for (let v = 0; v < 256; v++) if (lut[v] !== v) return false
  return true
}

/** RGB 共通のカーブを通したあと、チャンネル別のカーブを通す */
export function channelLuts(curve) {
  const base = buildLut(curve?.rgb ?? LINEAR_CURVE)
  const out = {}
  for (const ch of ['r', 'g', 'b']) {
    const per = buildLut(curve?.[ch] ?? LINEAR_CURVE)
    const lut = new Uint8Array(256)
    for (let v = 0; v < 256; v++) lut[v] = per[base[v]]
    out[ch] = lut
  }
  return out
}

/* ---------------- 有効判定とキャッシュキー ---------------- */

function curveActive(curve) {
  if (!curve?.on) return false
  return ['rgb', 'r', 'g', 'b'].some((ch) => !isIdentityLut(buildLut(curve[ch] ?? LINEAR_CURVE)))
}

/** このレイヤーに焼くものがあるか(何も無ければ後処理そのものを飛ばす) */
export function hasFx(fx) {
  if (!fx || fx.enabled === false) return false
  if (fx.blur?.on && fx.blur.radius > 0) return true
  if (fx.grade?.on && fx.grade.amount > 0) return true
  if (fx.light?.on && fx.light.amount > 0) return true
  if (fx.bloom?.on && fx.bloom.amount > 0) return true
  return curveActive(fx.curve)
}

/** 同じ設定なら同じ文字列。変わったらキャッシュを捨てる目印にする */
export function fxKey(fx) {
  if (!hasFx(fx)) return ''
  const parts = []
  if (fx.blur?.on && fx.blur.radius > 0) parts.push('bl' + fx.blur.radius)
  if (curveActive(fx.curve)) {
    parts.push('cv' + JSON.stringify([fx.curve.rgb, fx.curve.r, fx.curve.g, fx.curve.b]))
  }
  if (fx.grade?.on && fx.grade.amount > 0) {
    parts.push('gr' + [fx.grade.color, fx.grade.blend, fx.grade.amount].join(','))
  }
  if (fx.light?.on && fx.light.amount > 0) {
    const l = fx.light
    parts.push(
      'li' + [l.color, l.blend, l.amount, l.shape, l.x, l.y, l.radius, l.angle, l.pos, l.soft].join(','),
    )
  }
  if (fx.bloom?.on && fx.bloom.amount > 0) {
    parts.push('bm' + [fx.bloom.amount, fx.bloom.radius, fx.bloom.threshold].join(','))
  }
  return parts.join('|')
}

/* ---------------- 描画 ---------------- */

let filterOk = null

/** ctx.filter(ぼかし)が使えるか。古い Safari では使えない */
export function canvasFilterSupported() {
  if (filterOk != null) return filterOk
  if (typeof document === 'undefined') return (filterOk = false)
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.filter = 'blur(2px)'
    filterOk = ctx.filter !== 'none' && ctx.filter !== ''
  } catch {
    filterOk = false
  }
  return filterOk
}

function hexRgb(hex) {
  const s = String(hex || '').replace('#', '')
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s
  const n = Number.parseInt(full.slice(0, 6) || '000000', 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgba(hex, a) {
  const { r, g, b } = hexRgb(hex)
  return `rgba(${r},${g},${b},${clamp01(a)})`
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** トラックごとの作業用キャンバスと焼き上がりの置き場 */
const store = new Map()

function slotFor(trackId, w, h) {
  let s = store.get(trackId)
  if (!s || s.w !== w || s.h !== h) {
    s = { w, h, key: null, work: null, mask: null, temp: null, frames: new Map(), bytes: 0 }
    store.set(trackId, s)
  }
  return s
}

/** 消えたレイヤーの作業領域を手放す */
export function pruneFxCache(liveIds) {
  for (const id of [...store.keys()]) {
    if (!liveIds.has(id)) store.delete(id)
  }
}

export function clearFxCache() {
  store.clear()
}

function applyCurve(ctx, w, h, curve) {
  const { r: lr, g: lg, b: lb } = channelLuts(curve)
  const img = ctx.getImageData(0, 0, w, h)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue
    px[i] = lr[px[i]]
    px[i + 1] = lg[px[i + 1]]
    px[i + 2] = lb[px[i + 2]]
  }
  ctx.putImageData(img, 0, 0)
}

function lightGradient(ctx, w, h, light) {
  const solid = rgba(light.color, light.amount)
  const clear = rgba(light.color, 0)
  const soft = clamp01(light.soft ?? 0.7)

  if (light.shape === 'linear') {
    // 角度は数学の向き(0°=右, 90°=上)。その方向から光が差してくる
    const rad = ((light.angle ?? 90) * Math.PI) / 180
    const dx = Math.cos(rad)
    const dy = -Math.sin(rad)
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2
    const cx = w / 2
    const cy = h / 2
    const g = ctx.createLinearGradient(cx + dx * half, cy + dy * half, cx - dx * half, cy - dy * half)
    const reach = Math.max(0.02, clamp01(light.pos ?? 0.6))
    g.addColorStop(0, solid)
    g.addColorStop(reach * (1 - soft), solid)
    g.addColorStop(reach, clear)
    g.addColorStop(1, clear)
    return g
  }

  const R = Math.max(1, clamp01((light.radius ?? 0.9) / 2) * Math.hypot(w, h))
  const cx = clamp01(light.x ?? 0.5) * w
  const cy = clamp01(light.y ?? 0.5) * h
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
  g.addColorStop(0, solid)
  g.addColorStop(Math.max(0, 1 - soft), solid)
  g.addColorStop(1, clear)
  return g
}

/**
 * 明るいところだけ残す近似。
 * contrast(4) は 0.375 未満を黒に潰すので、先に brightness で threshold を
 * そこへ合わせてやる。ピクセル走査を挟まずに済むので速い。
 */
function bloomFilter(threshold, radius) {
  const t = Math.min(0.95, Math.max(0.05, threshold))
  const k = 0.375 / t
  return `brightness(${k.toFixed(4)}) contrast(4) blur(${radius}px)`
}

/**
 * 素材 1 枚に撮影処理を焼く。返り値は drawImage できる画。
 * frameKey を渡すと結果を溜めておき、同じコマは作り直さない。
 */
export function renderFx(src, w, h, fx, trackId, frameKey) {
  if (typeof document === 'undefined') return src
  if (!(w > 0) || !(h > 0)) return src

  const key = fxKey(fx)
  if (!key) return src

  const slot = slotFor(trackId, w, h)
  if (slot.key !== key) {
    slot.key = key
    slot.frames.clear()
    slot.bytes = 0
  }
  if (frameKey != null) {
    const hit = slot.frames.get(frameKey)
    if (hit) return hit
  }

  if (!slot.work) slot.work = makeCanvas(w, h)
  const ctx = slot.work.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.clearRect(0, 0, w, h)

  const filters = canvasFilterSupported()
  const blurR = fx.blur?.on ? Math.max(0, fx.blur.radius) : 0
  if (blurR > 0 && filters) {
    ctx.filter = `blur(${blurR}px)`
    ctx.drawImage(src, 0, 0, w, h)
    ctx.filter = 'none'
  } else {
    ctx.drawImage(src, 0, 0, w, h)
  }

  const grade = fx.grade?.on && fx.grade.amount > 0 ? fx.grade : null
  const light = fx.light?.on && fx.light.amount > 0 ? fx.light : null
  const bloom = fx.bloom?.on && fx.bloom.amount > 0 && filters ? fx.bloom : null

  // 光やカラーを足すと透明部分まで色が乗る。元のアルファで抜き直すための控え
  let mask = null
  if (grade || light) {
    if (!slot.mask) slot.mask = makeCanvas(w, h)
    mask = slot.mask
    const mc = mask.getContext('2d')
    mc.setTransform(1, 0, 0, 1, 0, 0)
    mc.globalAlpha = 1
    mc.globalCompositeOperation = 'source-over'
    mc.filter = 'none'
    mc.clearRect(0, 0, w, h)
    mc.drawImage(slot.work, 0, 0)
  }

  const reMask = () => {
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(mask, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
  }

  if (curveActive(fx.curve)) applyCurve(ctx, w, h, fx.curve)

  if (grade) {
    ctx.globalCompositeOperation = GRADE_BLENDS.includes(grade.blend) ? grade.blend : 'screen'
    ctx.fillStyle = rgba(grade.color, grade.amount)
    ctx.fillRect(0, 0, w, h)
    reMask()
  }

  if (light) {
    ctx.globalCompositeOperation = LIGHT_BLENDS.includes(light.blend) ? light.blend : 'screen'
    ctx.fillStyle = lightGradient(ctx, w, h, light)
    ctx.fillRect(0, 0, w, h)
    reMask()
  }

  if (bloom) {
    if (!slot.temp) slot.temp = makeCanvas(w, h)
    const tc = slot.temp.getContext('2d')
    tc.setTransform(1, 0, 0, 1, 0, 0)
    tc.globalAlpha = 1
    tc.globalCompositeOperation = 'source-over'
    tc.clearRect(0, 0, w, h)
    tc.filter = bloomFilter(bloom.threshold, Math.max(0, bloom.radius))
    tc.drawImage(slot.work, 0, 0)
    tc.filter = 'none'

    // ここは抜き直さない。ぼかした光がセルの輪郭より外へ滲み出て、
    // 背景に乗るのが撮影のグロー(透過光)なので、はみ出しをそのまま活かす
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, Math.max(0, bloom.amount))
    ctx.drawImage(slot.temp, 0, 0)
    ctx.globalAlpha = 1
  }

  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1

  if (frameKey == null) return slot.work

  // 作業用キャンバスは次のコマで上書きするので、控えを取ってから溜める
  const keep = makeCanvas(w, h)
  keep.getContext('2d').drawImage(slot.work, 0, 0)
  const bytes = w * h * 4
  while (slot.bytes + bytes > CACHE_BYTES && slot.frames.size > 0) {
    const oldest = slot.frames.keys().next().value
    slot.frames.delete(oldest)
    slot.bytes -= bytes
  }
  slot.frames.set(frameKey, keep)
  slot.bytes += bytes
  return keep
}

/* ---------------- プリセット ---------------- */

/** 撮影の定番。カーブは触らず、ぼかし・カラー・光・グローを差し替える */
export const FX_PRESETS = [
  {
    name: '夕方',
    grade: { color: '#ff8a3d', blend: 'screen', amount: 0.3 },
    light: { color: '#ffb457', blend: 'screen', amount: 0.6, shape: 'linear', angle: 20, pos: 0.75, soft: 0.9 },
  },
  {
    name: '夜',
    grade: { color: '#2b53a8', blend: 'multiply', amount: 0.45 },
    light: { color: '#9fc4ff', blend: 'screen', amount: 0.4, shape: 'radial', x: 0.5, y: 0.2, radius: 1.1, soft: 0.9 },
  },
  {
    name: '朝',
    grade: { color: '#bfe3ff', blend: 'screen', amount: 0.2 },
    light: { color: '#fff3d0', blend: 'screen', amount: 0.5, shape: 'radial', x: 0.72, y: 0.18, radius: 1, soft: 0.85 },
  },
  {
    name: '逆光',
    grade: { color: '#3a3f52', blend: 'multiply', amount: 0.3 },
    light: { color: '#fffbe8', blend: 'lighter', amount: 0.85, shape: 'radial', x: 0.5, y: 0.15, radius: 0.8, soft: 0.95 },
    bloom: { amount: 0.7, radius: 18, threshold: 0.55 },
  },
  {
    name: '回想',
    grade: { color: '#ffe6b0', blend: 'screen', amount: 0.35 },
    bloom: { amount: 0.8, radius: 22, threshold: 0.4 },
    blur: { radius: 2 },
  },
]

/** プリセットに書かれている工程だけ入れて、書かれていない工程は切る */
export function applyPreset(fx, preset) {
  const base = normalizeFx(fx)
  const next = { ...base, enabled: true }
  for (const part of ['blur', 'grade', 'light', 'bloom']) {
    const patch = preset[part]
    next[part] = patch ? { ...base[part], ...patch, on: true } : { ...base[part], on: false }
  }
  return next
}
