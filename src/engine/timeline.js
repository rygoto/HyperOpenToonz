import { nextId } from './ids.js'

/**
 * トラックとクリップのモデル。
 *
 *   cell  トラック … clip.in / clip.len の単位は「コマ数」(タイムシートの行)
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

/** セルのレイヤーのタイムシートの行数(sheet を持たなければ読み込んだ枚数。engine/sheet.js) */
export const sheetLength = (t) => (t.sheet ? t.sheet.length : t.frames.length)

/** 素材全体の長さ(クリップと同じ単位)。静止画は尺を持たないので無限 */
export const sourceUnits = (t) => {
  if (isCell(t)) return sheetLength(t)
  if (isBg(t)) return t.kind === 'video' && t.duration > 0 ? t.duration : Infinity
  return t.duration
}

export const clipLenSec = (t, c) => c.len / unitsPerSecond(t)
export const clipEndSec = (t, c) => c.start + clipLenSec(t, c)

/**
 * これ以上短くできない長さ(どのトラックも 20ms ぶん)。
 * セルも1コマ未満まで切れる。fps の違う相手(24fps の動画に 8fps のセルなど)と尻を揃えると、
 * 最後のコマが1コマに満たない長さになるため。
 */
export const minUnits = (t) => 0.02 * unitsPerSecond(t)

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

/**
 * クリップが素材の尻を越えて、もう映すものが無いか。
 * 短い素材に差し替えたクリップは長さを保つので、余った分は何も描かない(下地の色が出る)。
 */
export function bgPastEnd(track, clip, time) {
  if (track.kind !== 'video' || !(track.duration > 0)) return false
  return clip.in + (time - clip.start) >= track.duration + 1e-6
}

/** クリップのうち、素材の尻を越えている長さ(秒)。越えていなければ 0 */
export function bgOverrunSec(track, clip) {
  if (!isBg(track) || track.kind !== 'video' || !(track.duration > 0)) return 0
  return Math.min(clip.len, Math.max(0, clip.in + clip.len - track.duration))
}

/** 再生位置 time に当たるタイムシートの行。範囲外は null */
export function cellSheetRow(track, clip, time) {
  const local = time - clip.start
  if (local < 0 || local >= clip.len / trackFps(track)) return null
  const row = Math.floor(clip.in + local * trackFps(track) + 1e-6)
  if (row < 0) return 0
  const last = sheetLength(track) - 1
  return row > last ? last : row
}

/**
 * タイムライン上の time が、タイムシートの何行目の頭に当たるか(小数。行の途中なら端数が付く)。
 * time より前に始まる最後のクリップで数え、そのクリップが time に届いていなくても、そのまま先へ延ばして数える
 * (「ここまで埋めれば time に届く」を示すため)。当てはまるクリップが無ければ null。
 */
export function sheetRowAtTime(track, time) {
  let hit = null
  for (const c of track.clips) {
    if (c.start < time - 1e-6 && (!hit || c.start >= hit.start)) hit = c
  }
  return hit ? hit.in + (time - hit.start) * trackFps(track) : null
}

/** 再生位置 time に表示すべきコマ(track.frames の添字)。範囲外と空セルは null */
export function cellFrameIndex(track, clip, time) {
  const row = cellSheetRow(track, clip, time)
  if (row == null || !track.sheet) return row
  const cell = track.sheet[row]
  return cell >= 0 && cell < track.frames.length ? cell : null
}

/** at で2つに割る。割れない位置なら null */
export function splitClip(track, clip, at) {
  const u = unitsPerSecond(track)
  const off = (at - clip.start) * u
  const min = minUnits(track)
  if (off < min || clip.len - off < min) return null
  // フェードインとオーバーラップ(頭に掛かるもの)は前、フェードアウト(尻)は後ろに残す。
  // 「部屋の外」はクリップ全体に掛かるので両方に残す
  const { fadeOut, ...head } = clip
  const whole = {}
  for (const k of ['muffle', 'room']) if (clip[k] > 0) whole[k] = clip[k]
  return [
    { ...head, len: off },
    { id: nextId('clip'), start: at, in: clip.in + off, len: clip.len - off, ...(fadeOut > 0 ? { fadeOut } : {}), ...whole },
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

/** 尻を newEnd まで詰める / 伸ばす(素材の終端を超えない。もう超えているクリップは今の長さまで) */
export function trimClipEnd(track, clip, newEnd) {
  const u = unitsPerSecond(track)
  let len = (newEnd - clip.start) * u
  len = Math.min(len, Math.max(sourceUnits(track) - clip.in, clip.len))
  len = Math.max(len, minUnits(track))
  return { ...clip, len }
}

/**
 * 連動: fromSec 以降に始まるクリップを、どのレイヤーのものも delta 秒ずらす。
 * クリップの尻を動かしたとき、後ろに並んでいるものを同じだけ繰り下げる / 詰めるのに使う。
 * skipIds は動かさないクリップ(尻を動かした本人)。
 */
export function rippleFrom(tracks, fromSec, delta, skipIds = []) {
  if (!delta) return tracks
  return tracks.map((t) => {
    if (!t.clips.some((c) => c.start >= fromSec - 1e-6 && !skipIds.includes(c.id))) return t
    return replaceClips(
      t,
      t.clips.map((c) =>
        c.start >= fromSec - 1e-6 && !skipIds.includes(c.id) ? { ...c, start: Math.max(0, c.start + delta) } : c,
      ),
    )
  })
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

/**
 * 選んだ背景クリップを、別の素材のレイヤーへ移す(差し替え)。
 * 素材はレイヤーが持っているので、選ばれなかったクリップは元のレイヤーに残し、
 * 選んだ分だけを make(track, clips) がつくる新しいレイヤーに載せて、すぐ手前に置く。
 * クリップは位置と長さを保ち、新しい素材の頭から映す。make が null を返したレイヤーは触らない。
 */
export function replaceClipSource(tracks, clipIds, make) {
  const out = []
  let changed = false
  for (const t of tracks) {
    const picked = isBg(t) ? t.clips.filter((c) => clipIds.includes(c.id)) : []
    const made = picked.length > 0 ? make(t, picked.map((c) => ({ ...c, in: 0 }))) : null
    if (!made) {
      out.push(t)
      continue
    }
    changed = true
    const rest = t.clips.filter((c) => !picked.includes(c))
    if (rest.length > 0) out.push({ ...t, clips: rest })
    out.push(made)
  }
  return changed ? out : tracks
}

/** 音を分けられる動画のレイヤーか(音をまだ自分で鳴らしているもの) */
export const canDetachAudio = (t) => isBg(t) && t.kind === 'video' && !t.muted

/**
 * 選んだ動画クリップの音声を、別の音声トラックへ切り離す。
 *   audioFor(track, clips) … そのレイヤーの音を鳴らす音声トラックをつくる(clips はそのまま載せる)。null なら分けない
 *   layerFor(track)        … 選ばれなかったクリップが残るとき、選んだ分を載せる同じ素材のレイヤーをつくる
 * レイヤーのクリップを全部選んだときは、そのレイヤーを消音するだけ。
 * 一部だけのときは、選んだ分を消音した新しいレイヤーへ移してすぐ手前に置く(音はレイヤー単位でしか消せないため)。
 * 音声トラックは位置も素材の頭も長さも動画と同じで、並びの最後に足す。分けるものが無ければ null。
 */
export function detachAudio(tracks, clipIds, { audioFor, layerFor }) {
  const out = []
  const audios = []
  for (const t of tracks) {
    const picked = canDetachAudio(t) ? t.clips.filter((c) => clipIds.includes(c.id)) : []
    const audio = picked.length > 0 ? audioFor(t, picked.map((c) => ({ ...c, id: nextId('clip') }))) : null
    if (!audio) {
      out.push(t)
      continue
    }
    if (picked.length === t.clips.length) {
      out.push({ ...t, muted: true })
    } else {
      const layer = layerFor(t)
      if (!layer) {
        out.push(t)
        continue
      }
      out.push({ ...t, clips: t.clips.filter((c) => !picked.includes(c)) }, { ...layer, muted: true, clips: picked })
    }
    audios.push(audio)
  }
  return audios.length > 0 ? [...out, ...audios] : null
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

/** endSec より後ろを切り落とす(BGM を繰り返したとき、動画の尻からはみ出さないように) */
export function trimTrackTo(track, endSec) {
  const u = unitsPerSecond(track)
  const min = minUnits(track)
  const clips = []
  for (const c of track.clips) {
    if (c.start >= endSec - 1e-6) continue
    const len = Math.min(c.len, (endSec - c.start) * u)
    if (len < min) continue
    clips.push(len === c.len ? c : { ...c, len })
  }
  return clips.length === track.clips.length && clips.every((c, i) => c === track.clips[i])
    ? track
    : replaceClips(track, clips)
}

/**
 * from〜to(秒)にかかっているクリップを、その範囲だけに切り詰めて、from を 0 とした位置に直す。
 * 単位が秒のトラック(背景・音声)用。音声付加側のクリップ1つぶんをアニメーション側へ渡すのに使う。
 */
export function clipsInRange(track, from, to) {
  const out = []
  for (const c of track.clips) {
    const s = Math.max(c.start, from)
    const e = Math.min(clipEndSec(track, c), to)
    if (e - s < minUnits(track)) continue
    out.push({ id: nextId('clip'), start: s - from, in: c.in + (s - c.start), len: e - s, ...(c.name ? { name: c.name } : {}) })
  }
  return out
}

/** 書き出しに入るトラック(参考用に置いてあるだけのものは除く) */
export const outputTracks = (tracks) => tracks.filter((t) => !t.reference)

/** 貼り付け: 相対位置を保ったまま at を先頭にして並べ直す */
export function offsetClipsTo(clips, at) {
  if (clips.length === 0) return []
  const base = Math.min(...clips.map((c) => c.start))
  return clips.map((c) => ({ ...c, id: nextId('clip'), start: at + (c.start - base) }))
}

/* ---------- エフェクト ----------
 *
 * クリップに持たせる(どれも秒。0 や無しは掛けない)
 *   dissolve … 映像のオーバーラップ(ディゾルブ)。後ろのクリップに持たせる印(値は掛けたときの重なりの秒)。
 *              効くのは、タイムライン上で前のクリップ(別レイヤー)と実際に重なっている区間だけ。
 *              長さを変えるときはクリップの重なりを変える(両方とも自分の素材の範囲を普通に映す)
 *   olMid    … オーバーラップの推移の具合(0〜1。無しは 0.5 = 一定の速さ)。重なりのちょうど真ん中で、
 *              後ろのクリップがどれだけ見えているか。大きいほど早く替わり、小さいほど終わり際まで前のクリップが残る
 *   fadeIn / fadeOut … 音のフェードイン / フェードアウト
 */

/** olMid の範囲と既定値 */
export const OL_MID_MIN = 0.05
export const OL_MID_MAX = 0.95
export const OL_MID_DEFAULT = 0.5

/** clip の olMid(範囲に収めたもの) */
export const olMidOf = (clip) => (clip?.olMid > 0 ? Math.min(OL_MID_MAX, Math.max(OL_MID_MIN, clip.olMid)) : OL_MID_DEFAULT)

/**
 * オーバーラップの進み k(0〜1、時間の割合)のときに、後ろのクリップが見えている割合(0〜1)。
 * k = 0.5 で mid になる曲線 k^p(mid = 0.5 なら直線)
 */
export function olMix(k, mid = OL_MID_DEFAULT) {
  const x = Math.min(1, Math.max(0, k))
  const m = Math.min(OL_MID_MAX, Math.max(OL_MID_MIN, mid))
  return Math.pow(x, Math.log(m) / Math.log(0.5))
}

/** 前のクリップの尻と後ろのクリップの頭が、これだけ離れていても接しているとみなす(秒。掛けるときだけ使う) */
export const DISSOLVE_GAP = 0.05

/** オーバーラップとして扱う最短の重なり(秒) */
const MIN_OVERLAP = 0.001

/** オーバーラップを掛けられるトラック(動画 / 画像のレイヤー) */
export const canDissolve = (t) => isBg(t) && !t.reference

/** 音のフェードを掛けられるトラック(Web Audio で鳴らすもの) */
export const canFade = (t) => t.type === 'audio' || (isBg(t) && t.kind === 'video' && !!t.buffer && !t.muted)

/**
 * clip の頭に重なっている、別のレイヤーの映像クリップ(オーバーラップの相手)。
 * 頭より前に始まり、尻が頭を越えているもののうち、尻が一番後ろのもの(重なりが一番長い)
 */
export function dissolvePartner(tracks, track, clip) {
  let best = null
  for (const t of tracks) {
    if (t.id === track.id || !canDissolve(t)) continue
    for (const c of t.clips) {
      if (c.start >= clip.start - 1e-6) continue
      const end = clipEndSec(t, c)
      if (end <= clip.start + MIN_OVERLAP) continue
      if (!best || end > best.end) best = { track: t, clip: c, end }
    }
  }
  return best ? { track: best.track, clip: best.clip } : null
}

/**
 * 効いているオーバーラップの一覧。{ a, b, from, to } で、a が前・b が後ろ({ track, clip, index })、
 * from〜to(秒)が両方を重ねる範囲 = タイムライン上で2つのクリップが重なっているところ
 */
export function dissolvePairs(tracks) {
  const out = []
  tracks.forEach((t, bi) => {
    if (!canDissolve(t)) return
    for (const c of t.clips) {
      if (!(c.dissolve > 0)) continue
      const p = dissolvePartner(tracks, t, c)
      if (!p) continue
      const to = Math.min(clipEndSec(p.track, p.clip), clipEndSec(t, c))
      if (!(to - c.start > MIN_OVERLAP)) continue
      out.push({
        a: { track: p.track, clip: p.clip, index: tracks.indexOf(p.track) },
        b: { track: t, clip: c, index: bi },
        from: c.start,
        to,
      })
    }
  })
  return out
}

/** clipId のクリップが関わるオーバーラップ({ from, to, role: 'in' | 'out' })。無ければ null */
export function dissolveSpanOf(pairs, clipId) {
  for (const p of pairs) {
    if (p.b.clip.id === clipId) return { from: p.from, to: p.to, role: 'in' }
    if (p.a.clip.id === clipId) return { from: p.from, to: p.to, role: 'out' }
  }
  return null
}

/**
 * 映像のレイヤーが time に映すもの。{ clip, time(素材内の位置), alpha(不透明度に掛ける) } か null。
 * pairs は dissolvePairs(tracks) の結果(同じ並びのトラックから作ったもの)。
 * オーバーラップの範囲では、手前のレイヤーのほうを透かして、奥のレイヤーは普通に映す
 */
export function bgFrame(track, time, pairs = []) {
  let alpha = 1
  for (const p of pairs) {
    if (time < p.from || time >= p.to) continue
    const side = p.a.track.id === track.id ? p.a : p.b.track.id === track.id ? p.b : null
    if (!side) continue
    // 後ろのクリップが見えている割合。手前が前のクリップなら、その残りだけ前のクリップを映す
    const mix = olMix((time - p.from) / (p.to - p.from), olMidOf(p.b.clip))
    const front = side === p.a ? p.a.index > p.b.index : p.b.index > p.a.index
    alpha = !front ? 1 : side === p.a ? 1 - mix : mix
    break
  }
  const clip = activeClip(track, time)
  if (!clip || bgPastEnd(track, clip, time)) return null
  return { clip, time: bgSourceTime(track, clip, time), alpha }
}

/** フェードの長さ(秒)。足してクリップより長ければ、比を保って縮める */
export function fadeSpans(clip, lenSec) {
  let fi = clip.fadeIn > 0 ? clip.fadeIn : 0
  let fo = clip.fadeOut > 0 ? clip.fadeOut : 0
  if (fi + fo > lenSec && fi + fo > 0) {
    const s = lenSec / (fi + fo)
    fi *= s
    fo *= s
  }
  return { fadeIn: fi, fadeOut: fo }
}

/** クリップの頭から local 秒の音量の倍率(0〜1) */
export function fadeGainAt(clip, lenSec, local) {
  const { fadeIn, fadeOut } = fadeSpans(clip, lenSec)
  let g = 1
  if (fadeIn > 0 && local < fadeIn) g = Math.min(g, Math.max(0, local / fadeIn))
  if (fadeOut > 0 && local > lenSec - fadeOut) g = Math.min(g, Math.max(0, (lenSec - local) / fadeOut))
  return g
}

/**
 * AudioParam にフェードの山を描く。from〜lenSec(クリップの頭からの秒)を鳴らすとして、
 * at(local) がその瞬間の AudioContext の時刻を返す
 */
export function scheduleFade(param, clip, lenSec, from, at) {
  const { fadeIn, fadeOut } = fadeSpans(clip, lenSec)
  param.setValueAtTime(fadeGainAt(clip, lenSec, from), at(from))
  if (fadeIn <= 0 && fadeOut <= 0) return
  if (fadeIn > from) param.linearRampToValueAtTime(fadeGainAt(clip, lenSec, fadeIn), at(fadeIn))
  const foStart = lenSec - fadeOut
  if (fadeOut > 0) {
    if (foStart > from) param.setValueAtTime(fadeGainAt(clip, lenSec, foStart), at(foStart))
    param.linearRampToValueAtTime(0, at(lenSec))
  }
}

/** 動画クリップの尻の先に残っている素材(秒)。静止画は無限 */
function tailRoom(track, clip) {
  if (track.kind !== 'video' || !(track.duration > 0)) return Infinity
  return Math.max(0, track.duration - (clip.in + clip.len))
}

/** 動画クリップの頭の手前に残っている素材(秒)。静止画は無限 */
const headRoom = (track, clip) => (track.kind === 'video' ? Math.max(0, clip.in) : Infinity)

/**
 * 選んだ前後2つの映像クリップにオーバーラップを掛ける。
 * 同じレイヤーにあるときは、後ろのクリップを同じ素材の新しいレイヤーへ移してすぐ手前に置く
 * (1つの動画の要素では、同時に2か所を映せないため)。layerFor(track) がそのレイヤーをつくる(null なら掛けない)。
 *
 * オーバーラップが効くのは2つのクリップが重なっているところだけ。
 *   すでに重なっている … その重なりをそのまま使う(dur は使わない)
 *   接している         … 切れ目を真ん中に、前のクリップの尻と後ろのクリップの頭を dur/2 ずつ延ばして重ねる。
 *                        片側の素材(や隣のクリップまでの隙間)が足りなければ、もう片側を多めに延ばす
 * 結果は { tracks, overlap(秒), made(延ばして重ねたか) }。掛けられなければ { error }
 */
export function applyDissolve(tracks, clipIds, dur, { layerFor }) {
  const picked = []
  for (const t of tracks) {
    if (!canDissolve(t)) continue
    for (const c of t.clips) if (clipIds.includes(c.id)) picked.push({ track: t, clip: c })
  }
  if (picked.length !== 2) return { error: '前後に並んだ動画 / 画像のクリップを2つ選んでください' }
  picked.sort((x, y) => x.clip.start - y.clip.start)
  const [a, b] = picked
  const aEnd = clipEndSec(a.track, a.clip)
  if (!(a.clip.start < b.clip.start - 1e-6) || aEnd < b.clip.start - DISSOLVE_GAP) {
    return { error: '2つのクリップが接していません(前のクリップの尻に、後ろのクリップの頭をつけるか、重ねてください)' }
  }

  // 同じレイヤーなら、後ろのクリップを別のレイヤーへ移す
  let out = tracks
  let bTrackId = b.track.id
  if (a.track.id === b.track.id) {
    const layer = layerFor(b.track)
    if (!layer) return { error: 'クリップを別のレイヤーに分けられませんでした' }
    out = []
    for (const t of tracks) {
      if (t.id !== b.track.id) {
        out.push(t)
        continue
      }
      out.push({ ...t, clips: t.clips.filter((c) => c.id !== b.clip.id) }, { ...layer, clips: [b.clip] })
    }
    bTrackId = layer.id
  }
  const aTrack = out.find((t) => t.id === a.track.id)
  const bTrack = out.find((t) => t.id === bTrackId)
  const bEnd = clipEndSec(bTrack, b.clip)

  let head = 0 // 後ろのクリップの頭を手前へ延ばす秒
  let tail = 0 // 前のクリップの尻を先へ延ばす秒
  let overlap = aEnd - b.clip.start
  const made = !(overlap > MIN_OVERLAP)
  if (made) {
    const gap = Math.max(0, -overlap)
    // 延ばせる上限: 素材の余り / 同じレイヤーの隣のクリップまで / 相手のクリップを追い越さない
    const prevEnd = Math.max(-Infinity, ...bTrack.clips.filter((c) => c.id !== b.clip.id && c.start < b.clip.start).map((c) => clipEndSec(bTrack, c)))
    const nextStart = Math.min(Infinity, ...aTrack.clips.filter((c) => c.id !== a.clip.id && c.start > a.clip.start).map((c) => c.start))
    const headMax = Math.max(0, Math.min(headRoom(bTrack, b.clip), b.clip.start - Math.max(prevEnd, 0), b.clip.start - a.clip.start - MIN_OVERLAP))
    const tailMax = Math.max(0, Math.min(tailRoom(aTrack, a.clip), nextStart - aEnd, bEnd - aEnd - MIN_OVERLAP))
    head = Math.min(dur / 2, headMax)
    tail = Math.min(dur - head + gap, tailMax)
    head = Math.min(headMax, Math.max(head, dur - (tail - gap)))
    overlap = head + tail - gap
    if (!(overlap > MIN_OVERLAP)) {
      return { error: '素材の余りが無いので重ねられません(2つのクリップをタイムライン上で重ねてから掛けてください)' }
    }
  }

  const round = (x) => Math.round(x * 100) / 100
  const nextB = {
    ...b.clip,
    start: b.clip.start - head,
    in: bTrack.kind === 'video' ? b.clip.in - head : b.clip.in,
    len: b.clip.len + head,
    dissolve: round(overlap),
  }
  const nextA = { ...a.clip, len: a.clip.len + tail }
  return {
    tracks: out.map((t) => {
      if (t.id === bTrack.id) return replaceClips(t, t.clips.map((c) => (c.id === b.clip.id ? nextB : c)))
      if (t.id === aTrack.id && tail > 0) return replaceClips(t, t.clips.map((c) => (c.id === a.clip.id ? nextA : c)))
      return t
    }),
    overlap: round(overlap),
    made,
  }
}

/** 選んだクリップの、エフェクトの値を書き換える(patch の値が 0 / null なら外す) */
export function patchClipEffects(tracks, clipIds, patch, allow = () => true) {
  let changed = false
  const next = tracks.map((t) => {
    if (!allow(t) || !t.clips.some((c) => clipIds.includes(c.id))) return t
    changed = true
    return {
      ...t,
      clips: t.clips.map((c) => {
        if (!clipIds.includes(c.id)) return c
        const out = { ...c }
        for (const [k, v] of Object.entries(patch)) {
          if (v > 0) out[k] = v
          else delete out[k]
        }
        return out
      }),
    }
  })
  return changed ? next : tracks
}
