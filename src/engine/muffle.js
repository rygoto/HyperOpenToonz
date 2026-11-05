/**
 * 音声のエフェクト「部屋の外」。壁やドア越しに聞こえるような、こもった声にする。
 * クリップに持たせる(どれも 0〜1。無しは掛けない)
 *   muffle … こもり具合。高い音をどこまで削るか(大きいほど低いところから削る = 分厚い壁)
 *   room   … 響き。隣の部屋の壁で跳ね返った短い残響を、どれだけ足すか
 *
 * 音のつなぎ方: 入力 → ローパス2段(壁は高い音ほど通さない) → 低音を少し持ち上げる → 小さくする → 出力
 *                                                       └→ 残響(短い部屋鳴り) → 出力
 * プレビュー(audio.js)と書き出し(mixAudio.js)で同じものを挟むので、聞こえ方は揃う
 */

/** 「掛ける」を押したときの値 */
export const MUFFLE_DEFAULT = { muffle: 0.6, room: 0.25 }

export const hasMuffle = (clip) => clip?.muffle > 0

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))

/** 削り始める周波数の範囲(Hz)。こもり具合 0 で上、1 で下 */
const CUTOFF_LIGHT = 3200
const CUTOFF_HEAVY = 280

/** クリップの値から、実際に使う数値を決める(テスト用に分けてある) */
export function muffleParams(clip) {
  const m = Math.max(0.05, clamp01(clip?.muffle))
  const room = clamp01(clip?.room)
  return {
    // 耳は周波数を比で聞くので、指数で動かす
    cutoff: CUTOFF_LIGHT * Math.pow(CUTOFF_HEAVY / CUTOFF_LIGHT, m),
    // 壁を通ると全体が小さくなる。残響のぶんも少し下げておく
    dry: (1 - 0.35 * m) * (1 - 0.25 * room),
    wet: room * 0.7,
    // 低いところ(足音や声の胴鳴り)は壁を抜けやすい
    lowBoostDb: 2 + 3 * m,
  }
}

/** 決まった種から作る乱数(プレビューと書き出しで同じ残響にするため) */
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 残響の素(インパルス応答)。小さな部屋の、0.6秒ほどで消える鳴り。AudioContext ごとに1回だけ作る */
const impulses = new WeakMap()
function roomImpulse(ctx) {
  const cached = impulses.get(ctx)
  if (cached) return cached
  const rate = ctx.sampleRate
  const len = Math.round(rate * 0.6)
  const buf = ctx.createBuffer(2, len, rate)
  for (let ch = 0; ch < 2; ch++) {
    const rnd = seeded(1234 + ch * 777)
    const d = buf.getChannelData(ch)
    const pre = Math.round(rate * 0.008) // 最初の反射までの間
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate
      d[i] = (rnd() * 2 - 1) * Math.exp(-t / 0.11)
    }
  }
  impulses.set(ctx, buf)
  return buf
}

/**
 * input のあとに「部屋の外」の処理を挟んで、出口の GainNode を返す。
 * nodes は後で disconnect するためのもの
 */
export function insertMuffle(ctx, input, clip) {
  const p = muffleParams(clip)
  const lp1 = ctx.createBiquadFilter()
  lp1.type = 'lowpass'
  lp1.frequency.value = p.cutoff
  lp1.Q.value = 0.7
  const lp2 = ctx.createBiquadFilter()
  lp2.type = 'lowpass'
  lp2.frequency.value = p.cutoff * 1.4
  lp2.Q.value = 0.5
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = 220
  low.gain.value = p.lowBoostDb
  const dry = ctx.createGain()
  dry.gain.value = p.dry
  const out = ctx.createGain()

  input.connect(lp1)
  lp1.connect(lp2)
  lp2.connect(low)
  low.connect(dry)
  dry.connect(out)
  const nodes = [lp1, lp2, low, dry, out]

  if (p.wet > 0.001) {
    const conv = ctx.createConvolver()
    conv.buffer = roomImpulse(ctx)
    const wet = ctx.createGain()
    wet.gain.value = p.wet
    low.connect(conv)
    conv.connect(wet)
    wet.connect(out)
    nodes.push(conv, wet)
  }
  return { out, nodes }
}
