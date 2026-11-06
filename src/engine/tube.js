/**
 * 音声のエフェクト「伝声管」。ラッパ(ホーン)や金属の管を通って出てくるような、細くて鼻にかかった声にする。
 * クリップに持たせる(どれも 0〜1。無しは掛けない)
 *   tube … 管の細さ。大きいほど低い音も高い音も削れて、管の鳴り(共鳴)が強くなる
 *   pipe … 管の長さ。管の中で行き来する金属っぽい反響(短いやまびこ)の長さと強さ
 *
 * 音のつなぎ方:
 *   入力 → ハイパス → ローパス(管は狭い帯域しか通さない) → 共鳴2つ(ホーンの鳴り) → 軽い歪み → dry → 出力
 *                                                                                    └→ 遅延 ⇄ 帰還(管の反響) → wet → 出力
 * 「部屋の外」と同じく、プレビュー(audio.js)と書き出し(mixAudio.js)で同じものを挟む
 */

/** 「掛ける」を押したときの値 */
export const TUBE_DEFAULT = { tube: 0.55, pipe: 0.35 }

export const hasTube = (clip) => clip?.tube > 0

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))

/** クリップの値から、実際に使う数値を決める(テスト用に分けてある) */
export function tubeParams(clip) {
  const t = Math.max(0.05, clamp01(clip?.tube))
  const pipe = clamp01(clip?.pipe)
  return {
    // 通す帯域。細いほど狭くなる(電話より少し広い〜電話より狭い)
    highpass: 250 + 450 * t,
    lowpass: 4200 * Math.pow(1700 / 4200, t),
    // ホーンの鳴り。鼻にかかった「ホー」という響きの山
    peaks: [
      { freq: 950 + 250 * t, q: 3 + 3 * t, db: 4 + 6 * t },
      { freq: 2300 + 300 * t, q: 4 + 3 * t, db: 2 + 5 * t },
    ],
    // 金属の管がわずかに割れる感じ
    drive: 1 + 2.5 * t,
    dry: 0.75 - 0.15 * t,
    // 管の中の行き来。長い管ほど間が開いて、よく返る
    delay: 0.004 + 0.022 * pipe,
    feedback: pipe > 0 ? 0.3 + 0.35 * pipe : 0,
    wet: pipe * 0.6,
  }
}

/** 歪みのカーブ(tanh。音量はおおよそ揃える) */
const curves = new Map()
function driveCurve(drive) {
  const key = Math.round(drive * 100)
  const cached = curves.get(key)
  if (cached) return cached
  const n = 1024
  const c = new Float32Array(n)
  const norm = Math.tanh(drive)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(drive * x) / norm
  }
  curves.set(key, c)
  return c
}

/**
 * input のあとに「伝声管」の処理を挟んで、出口の GainNode を返す。
 * nodes は後で disconnect するためのもの(帰還のループもここで切れる)
 */
export function insertTube(ctx, input, clip) {
  const p = tubeParams(clip)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = p.highpass
  hp.Q.value = 0.8
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = p.lowpass
  lp.Q.value = 1.2
  input.connect(hp)
  hp.connect(lp)
  const nodes = [hp, lp]

  let last = lp
  for (const k of p.peaks) {
    const f = ctx.createBiquadFilter()
    f.type = 'peaking'
    f.frequency.value = k.freq
    f.Q.value = k.q
    f.gain.value = k.db
    last.connect(f)
    nodes.push(f)
    last = f
  }

  const shaper = ctx.createWaveShaper()
  shaper.curve = driveCurve(p.drive)
  shaper.oversample = '2x'
  last.connect(shaper)
  const dry = ctx.createGain()
  dry.gain.value = p.dry
  const out = ctx.createGain()
  shaper.connect(dry)
  dry.connect(out)
  nodes.push(shaper, dry, out)

  if (p.wet > 0.001) {
    const delay = ctx.createDelay(0.1)
    delay.delayTime.value = p.delay
    // 返るたびに高い音が削れていく(管の壁で吸われる)
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 2600
    damp.Q.value = 0.5
    const fb = ctx.createGain()
    fb.gain.value = p.feedback
    const wet = ctx.createGain()
    wet.gain.value = p.wet
    dry.connect(delay)
    delay.connect(damp)
    damp.connect(fb)
    fb.connect(delay)
    damp.connect(wet)
    wet.connect(out)
    nodes.push(delay, damp, fb, wet)
  }
  return { out, nodes }
}
