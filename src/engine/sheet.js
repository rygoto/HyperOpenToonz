import { makeClip, minUnits, replaceClips, sheetLength, sortClips, trackFps } from './timeline.js'

/**
 * タイムシート: セルのレイヤーが「何コマ目にどのセルを出すか」の表。
 *
 *   track.sheet[行] = セルの番号(0 始まり。track.frames の添字)。EMPTY は空セル(何も出さない)
 *
 * sheet を持たないレイヤーは、読み込んだ順(0, 1, 2, …)に1コマずつ並んでいるものとして扱う。
 * clip.in / clip.len はこの表の行を数えるので、表を伸ばせばクリップもそのぶん長くできる。
 *
 * 範囲を取る関数は a と b の両端を含み、{ sheet, a, b }(編集後の表と、選び直す範囲)を返す。
 */

export const EMPTY = -1

/** 読み込んだ順に1コマずつ並べた表 */
export const identitySheet = (count) => Array.from({ length: count }, (_, i) => i)

export const sheetOf = (track) => track.sheet ?? identitySheet(track.frames.length)

/** 読み込んだ順のままか(シーンに書き出す必要が無いか) */
export function isDefaultSheet(track) {
  const s = track.sheet
  return !s || (s.length === track.frames.length && s.every((v, i) => v === i))
}

/** 無いセルを指している行は空セルにし、尻の空セルは落とす(最低1行は残す) */
export function normalizeSheet(sheet, count) {
  const out = []
  for (const v of sheet ?? []) {
    out.push(typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : EMPTY)
  }
  while (out.length > 1 && out[out.length - 1] === EMPTY) out.pop()
  if (out.length === 0) out.push(EMPTY)
  return out
}

/** 表の中に収まる範囲。表の外だけを指していれば null */
function inside(sheet, a, b) {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(sheet.length - 1, Math.max(a, b))
  return lo <= hi ? [lo, hi] : null
}

/** 範囲を1つのセルで埋める。表の尻より先なら、そこまで空セルで伸ばす */
export function setCells(sheet, a, b, cell) {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.max(a, b)
  const out = sheet.slice()
  while (out.length <= hi) out.push(EMPTY)
  out.fill(cell, lo, hi + 1)
  return { sheet: out, a: lo, b: hi }
}

/** 貼り付け: at の行から cells を上書きする。表の尻より先なら、そこまで空セルで伸ばす */
export function pasteCells(sheet, at, cells) {
  if (cells.length === 0) return { sheet, a: at, b: at }
  const out = sheet.slice()
  while (out.length < at) out.push(EMPTY)
  for (let i = 0; i < cells.length; i++) out[at + i] = cells[i]
  return { sheet: out, a: at, b: at + cells.length - 1 }
}

/**
 * 引き伸ばし: 範囲の尻を to の行まで動かす。
 *   下へ … 範囲の並びを繰り返して to まで差し込む(1行だけなら、そのセルを to まで止める)
 *   上へ … to より下の行を範囲から抜く(先頭の1行は残す)
 * どちらも、範囲より後ろの行は同じだけ繰り下がる / 繰り上がる。
 */
export function fillRows(sheet, a, b, to) {
  const r = inside(sheet, a, b)
  if (!r) return { sheet, a, b }
  const [lo, hi] = r
  const end = Math.max(lo, to)
  if (end === hi) return { sheet, a: lo, b: hi }
  const n = hi - lo + 1
  const block = []
  for (let i = lo; i <= end; i++) block.push(sheet[lo + ((i - lo) % n)])
  return { sheet: [...sheet.slice(0, lo), ...block, ...sheet.slice(hi + 1)], a: lo, b: end }
}

/** 伸ばす: 範囲の最後のセルを、もう n コマ止める(後ろは繰り下がる) */
export function holdRows(sheet, a, b, n = 1) {
  const r = inside(sheet, a, b)
  if (!r) return { sheet, a, b }
  const [lo, hi] = r
  return {
    sheet: [...sheet.slice(0, hi + 1), ...new Array(n).fill(sheet[hi]), ...sheet.slice(hi + 1)],
    a: lo,
    b: hi + n,
  }
}

/** 詰める: 範囲の行を抜く(後ろは繰り上がる) */
export function removeRows(sheet, a, b) {
  const r = inside(sheet, a, b)
  if (!r) return { sheet, a, b }
  const [lo, hi] = r
  const out = [...sheet.slice(0, lo), ...sheet.slice(hi + 1)]
  const at = Math.max(0, Math.min(lo, out.length - 1))
  return { sheet: out, a: at, b: at }
}

/** 繰り返す: 範囲をそのすぐ後ろにもう1回ぶん差し込む */
export function repeatRows(sheet, a, b) {
  const r = inside(sheet, a, b)
  if (!r) return { sheet, a, b }
  const [lo, hi] = r
  return {
    sheet: [...sheet.slice(0, hi + 1), ...sheet.slice(lo, hi + 1), ...sheet.slice(hi + 1)],
    a: lo,
    b: hi,
  }
}

/** 範囲の並びを逆にする */
export function reverseRows(sheet, a, b) {
  const r = inside(sheet, a, b)
  if (!r) return { sheet, a, b }
  const [lo, hi] = r
  return {
    sheet: [...sheet.slice(0, lo), ...sheet.slice(lo, hi + 1).reverse(), ...sheet.slice(hi + 1)],
    a: lo,
    b: hi,
  }
}

/** コマ打ち: 範囲に出てくるセルを順に n コマずつ止め直す(2 なら2コマ打ち) */
export function stepRows(sheet, a, b, n) {
  const r = inside(sheet, a, b)
  if (!r || !(n >= 1)) return { sheet, a, b }
  const [lo, hi] = r
  const block = []
  for (let i = lo; i <= hi; i++) {
    if (i > lo && sheet[i] === sheet[i - 1]) continue
    for (let k = 0; k < n; k++) block.push(sheet[i])
  }
  return {
    sheet: [...sheet.slice(0, lo), ...block, ...sheet.slice(hi + 1)],
    a: lo,
    b: lo + block.length - 1,
  }
}

/**
 * レイヤーの表を入れ替える。
 * 表の尻まで映していたクリップは新しい尻まで伸び縮みさせ、そのクリップより後ろに置いてあった
 * 同じレイヤーのクリップは同じだけずらす(繰り返しで並べたものが重ならないように)。
 * 途中までのクリップは、表が短くなってはみ出した分だけ切る。
 */
export function applySheet(track, next) {
  const sheet = normalizeSheet(next, track.frames.length)
  const prev = sheetOf(track)
  if (sheet.length === prev.length && sheet.every((v, i) => v === prev[i])) return track

  const oldLen = sheetLength(track)
  const newLen = sheet.length
  const fps = trackFps(track)
  const resized = []
  const clips = []
  for (const c of sortClips(track.clips)) {
    let shift = 0
    for (const m of resized) if (c.start >= m.end - 1e-6) shift += m.delta
    const len = c.in + c.len >= oldLen - 1e-6 ? newLen - c.in : Math.min(c.len, newLen - c.in)
    if (!(len >= minUnits(track))) continue
    if (len !== c.len) resized.push({ end: c.start + c.len / fps, delta: (len - c.len) / fps })
    const start = Math.max(0, c.start + shift)
    clips.push(start === c.start && len === c.len ? c : { ...c, start, len })
  }
  const out = { ...track, sheet }
  return replaceClips(out, clips.length > 0 ? clips : [makeClip(out, { start: 0 })])
}
