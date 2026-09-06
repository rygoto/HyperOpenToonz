import { nextId } from './ids.js'

/**
 * トラックとクリップのモデル。
 *
 *   cell  トラック … clip.in / clip.len の単位は「素材のコマ数」
 *   bg    トラック … 背景 / BOOK。単位は秒(静止画は素材の尺を持たない)
 *   audio トラック … clip.in / clip.len の単位は「秒」
 *
 * clip.start は常にタイムライン上の秒。
 * cell を秒ではなくコマで持つことで、トラックの fps を変えても
 * 「何コマ目から何コマぶん」という編集結果が保たれる。
 */

export const isCell = (t) => t.type === 'cell'
export const isBg = (t) => t.type === 'bg'

/** 絵として重なるトラック(重なり順は配列の後ろほど手前) */
export const isVisual = (t) => t.type === 'cell' || t.type === 'bg'

export const trackFps = (t) => (t.fps > 0 ? t.fps : 24)

/** clip.in / clip.len の単位を秒に直すための係数 */
export const unitsPerSecond = (t) => (isCell(t) ? trackFps(t) : 1)

/** 素材全体の長さ(クリップと同じ単位)。静止画は尺を持たないので無限 */
export const sourceUnits = (t) => {
  if (isCell(t)) return t.frames.length
  if (isBg(t)) return t.kind === 'video' && t.duration > 0 ? t.duration : Infinity
  return t.duration
}

export const clipLenSec = (t, c) => c.len / unitsPerSecond(t)
export const clipEndSec = (t, c) => c.start + clipLenSec(t, c)

/** これ以上短くできない長さ(セルは1コマ、音声は20ms) */
export const minUnits = (t) => (isCell(t) ? 1 : 0.02)

export function trackEndSec(t) {
  let end = 0
  for (const c of t.clips) end = Math.max(end, clipEndSec(t, c))
  return end
}

export function projectDurationSec(tracks) {
  let d = 0
  for (const t of tracks) d = Math.max(d, trackEndSec(t))
  return d
}

export function makeClip(track, { start = 0, in: from = 0, len } = {}) {
  return {
    id: nextId('clip'),
    start,
    in: from,
    len: len ?? sourceUnits(track),
  }
}

export function clipContains(track, clip, time) {
  return time >= clip.start && time < clipEndSec(track, clip)
}

/** time にかかっているクリップ。重なっていれば後ろのものを採る */
export function activeClip(track, time) {
  let hit = null
  for (const c of track.clips) {
    if (clipContains(track, c, time)) hit = c
  }
  return hit
}

/** 背景トラックが time に表示すべき、素材内の再生位置(静止画は常に0) */
export function bgSourceTime(track, clip, time) {
  if (track.kind !== 'video') return 0
  const t = clip.in + (time - clip.start)
  const dur = track.duration > 0 ? track.duration : 0
  if (dur <= 0) return Math.max(0, t)
  return Math.min(Math.max(0, t), Math.max(0, dur - 0.001))
}

/** 再生位置 time に表示すべきコマ。範囲外は null */
export function cellFrameIndex(track, clip, time) {
  const local = time - clip.start
  if (local < 0 || local >= clip.len / trackFps(track)) return null
  const idx = Math.floor(clip.in + local * trackFps(track) + 1e-6)
  if (idx < 0) return 0
  const last = track.frames.length - 1
  return idx > last ? last : idx
}

/** at で2つに割る。割れない位置なら null */
export function splitClip(track, clip, at) {
  const u = unitsPerSecond(track)
  const off = (at - clip.start) * u
  const min = minUnits(track)
  if (off < min || clip.len - off < min) return null
  return [
    { ...clip, len: off },
    { id: nextId('clip'), start: at, in: clip.in + off, len: clip.len - off },
  ]
}

/** 頭を newStart まで詰める / 伸ばす(素材の先頭より前へは伸びない) */
export function trimClipStart(track, clip, newStart) {
  const u = unitsPerSecond(track)
  let d = (newStart - clip.start) * u
  d = Math.max(d, -clip.in)
  d = Math.max(d, -clip.start * u) // タイムラインの 0 より前には出さない
  d = Math.min(d, clip.len - minUnits(track))
  return { ...clip, start: clip.start + d / u, in: clip.in + d, len: clip.len - d }
}

/** 尻を newEnd まで詰める / 伸ばす(素材の終端を超えない) */
export function trimClipEnd(track, clip, newEnd) {
  const u = unitsPerSecond(track)
  let len = (newEnd - clip.start) * u
  len = Math.min(len, sourceUnits(track) - clip.in)
  len = Math.max(len, minUnits(track))
  return { ...clip, len }
}

export function sortClips(clips) {
  return [...clips].sort((a, b) => a.start - b.start)
}

export function mapTrack(tracks, trackId, fn) {
  return tracks.map((t) => (t.id === trackId ? fn(t) : t))
}

export function replaceClips(track, clips) {
  return { ...track, clips: sortClips(clips) }
}

/** クリップを複製して end まで並べる */
export function repeatToFill(track, endSec) {
  if (track.clips.length === 0) return track
  const src = track.clips[track.clips.length - 1]
  const len = clipLenSec(track, src)
  if (len <= 0.001) return track
  const clips = [...track.clips]
  let start = clipEndSec(track, src)
  let guard = 0
  while (start < endSec - 1e-6 && guard++ < 2000) {
    clips.push({ ...src, id: nextId('clip'), start })
    start += len
  }
  return replaceClips(track, clips)
}

/** 貼り付け: 相対位置を保ったまま at を先頭にして並べ直す */
export function offsetClipsTo(clips, at) {
  if (clips.length === 0) return []
  const base = Math.min(...clips.map((c) => c.start))
  return clips.map((c) => ({ ...c, id: nextId('clip'), start: at + (c.start - base) }))
}
