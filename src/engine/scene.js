/**
 * シーン(プロジェクト)を JSON に書き出す / JSON からシーンを組み直す。
 *
 * 入れるもの … レイヤーの構成・重なり順・配置・合成・撮影処理・クリップ・
 *              ステージ設定・プロジェクト fps・音量、そして素材のファイル名
 * 入れないもの … 絵と音そのもの(画素と波形)
 *
 * 連番セルを丸ごと抱えると JSON が何百 MB にもなってしまうので、素材は
 * 「ファイル名で覚えておいて、読み込むときに選び直してもらう」形にしている。
 * 名前で結び直すので、書き出したときと同じ素材さえ渡せば元の絵に戻る。
 */
import { decodeAudioFile } from './audio.js'
import { normalizeFx } from './fx.js'
import { nextId } from './ids.js'
import { loadBackground, loadCellSequence } from './media.js'
import { makeClip, minUnits, sortClips, sourceUnits } from './timeline.js'

export const SCENE_APP = 'PiyopiyoToonz'
export const SCENE_KIND = 'scene'
export const SCENE_VERSION = 1
export const SCENE_EXT = 'json'

/** 素材を名前で結び直すときの鍵(大文字小文字とパスの違いは無視する) */
export const assetKey = (name) => String(name ?? '').split(/[\\/]/).pop().toLowerCase()

/** JSON を人が読める程度に丸める */
const r = (v, digits = 6) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const k = 10 ** digits
  return Math.round(n * k) / k
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const str = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback)

/* ---------------- 書き出し ---------------- */

const clipJson = (c) => ({ start: r(c.start), in: r(c.in), len: r(c.len) })

/** 絵のレイヤーに共通する、置き方と見え方 */
const placeJson = (t) => ({
  fit: str(t.fit, 'contain'),
  opacity: r(t.opacity),
  scale: r(t.scale),
  x: r(t.x),
  y: r(t.y),
  blend: str(t.blend, 'source-over'),
  visible: t.visible !== false,
})

function trackJson(t) {
  const clips = t.clips.map(clipJson)

  if (t.type === 'bg') {
    return {
      type: 'bg',
      kind: t.kind,
      name: t.name,
      files: [t.fileName ?? t.name],
      source: { width: t.width, height: t.height, duration: r(t.duration) },
      ...placeJson(t),
      muted: !!t.muted,
      fx: normalizeFx(t.fx),
      clips,
    }
  }

  if (t.type === 'cell') {
    return {
      type: 'cell',
      name: t.name,
      files: [...(t.files ?? [])],
      source: { count: t.frames.length, width: t.width, height: t.height },
      fps: num(t.fps, 8),
      ...placeJson(t),
      fx: normalizeFx(t.fx),
      clips,
    }
  }

  if (t.type === 'audio') {
    return {
      type: 'audio',
      name: t.name,
      files: [t.fileName ?? t.name],
      source: { duration: r(t.duration) },
      gain: r(t.gain),
      muted: !!t.muted,
      clips,
    }
  }

  return null
}

export function serializeScene({ tracks, stage, projectFps, muted, volume, name }) {
  return {
    app: SCENE_APP,
    kind: SCENE_KIND,
    version: SCENE_VERSION,
    savedAt: new Date().toISOString(),
    project: {
      name: str(name),
      fps: num(projectFps, 24),
      muted: !!muted,
      volume: r(volume),
    },
    stage: {
      width: num(stage.width, 1920),
      height: num(stage.height, 1080),
      autoSize: stage.autoSize !== false,
      bgColor: str(stage.bgColor, '#000000'),
      checker: stage.checker !== false,
    },
    // 配列の順がそのまま重なり順(後ろほど手前)
    tracks: tracks.map(trackJson).filter(Boolean),
  }
}

export function sceneToText(scene) {
  return JSON.stringify(scene, null, 2)
}

/* ---------------- 読み込み ---------------- */

function clipIn(c) {
  return {
    start: Math.max(0, num(c?.start, 0)),
    in: Math.max(0, num(c?.in, 0)),
    len: num(c?.len, 0),
  }
}

function placeIn(t) {
  return {
    fit: str(t.fit, 'contain'),
    opacity: Math.min(1, Math.max(0, num(t.opacity, 1))),
    scale: Math.max(0.01, num(t.scale, 1)),
    x: num(t.x, 0),
    y: num(t.y, 0),
    blend: str(t.blend, 'source-over'),
    visible: t.visible !== false,
  }
}

function trackIn(t, i) {
  if (!t || typeof t !== 'object') return null
  const files = Array.isArray(t.files) ? t.files.filter((n) => typeof n === 'string' && n) : []
  if (files.length === 0) return null
  const clips = Array.isArray(t.clips) ? t.clips.map(clipIn) : []
  const name = str(t.name, `レイヤー${i + 1}`)

  if (t.type === 'bg') {
    return { type: 'bg', kind: str(t.kind, 'image'), name, files, clips, muted: !!t.muted, fx: normalizeFx(t.fx), ...placeIn(t) }
  }
  if (t.type === 'cell') {
    return { type: 'cell', name, files, clips, fps: Math.max(1, num(t.fps, 8)), fx: normalizeFx(t.fx), ...placeIn(t) }
  }
  if (t.type === 'audio') {
    return { type: 'audio', name, files, clips, gain: Math.max(0, num(t.gain, 1)), muted: !!t.muted }
  }
  return null
}

/**
 * 保存した JSON を読み解く。形が違えば理由を添えて投げる。
 * 返るのは「素材を結び直す前」のシーン(files はファイル名のまま)。
 */
export function parseScene(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSON として読み取れませんでした')
  }
  if (!data || typeof data !== 'object' || data.app !== SCENE_APP || data.kind !== SCENE_KIND) {
    throw new Error('PiyopiyoToonz のシーンファイルではありません')
  }
  if (num(data.version, 1) > SCENE_VERSION) {
    throw new Error('新しい版のシーンファイルです。アプリを更新してください')
  }
  const tracks = (Array.isArray(data.tracks) ? data.tracks : []).map(trackIn).filter(Boolean)
  if (tracks.length === 0) throw new Error('レイヤーが入っていないシーンファイルです')

  const stage = data.stage ?? {}
  const project = data.project ?? {}
  return {
    version: num(data.version, 1),
    savedAt: str(data.savedAt),
    project: {
      name: str(project.name),
      fps: Math.max(1, num(project.fps, 24)),
      muted: !!project.muted,
      volume: Math.min(1, Math.max(0, num(project.volume, 1))),
    },
    stage: {
      width: Math.max(16, num(stage.width, 1920)),
      height: Math.max(16, num(stage.height, 1080)),
      autoSize: stage.autoSize !== false,
      bgColor: str(stage.bgColor, '#000000'),
      checker: stage.checker !== false,
    },
    tracks,
  }
}

/** シーンが必要としている素材のファイル名(重複は畳む) */
export function sceneAssetNames(scene) {
  const out = new Map()
  for (const t of scene.tracks) {
    for (const n of t.files) if (!out.has(assetKey(n))) out.set(assetKey(n), n)
  }
  return [...out.values()]
}

/** 渡された素材のうち、そのレイヤーで見つかった数 */
export function foundCount(track, pool) {
  let n = 0
  for (const name of track.files) if (pool.has(assetKey(name))) n++
  return n
}

/**
 * 素材の実物に合わせてクリップを詰め直す。
 * 選び直した素材が短くなっていても、はみ出した分を切って形は保つ。
 */
function fitClips(track, clips) {
  const total = sourceUnits(track)
  const min = minUnits(track)
  const out = []
  for (const c of clips) {
    const from = Number.isFinite(total) ? Math.min(c.in, Math.max(0, total - min)) : c.in
    let len = c.len
    if (Number.isFinite(total)) len = Math.min(len, total - from)
    if (!(len >= min)) continue
    out.push({ id: nextId('clip'), start: c.start, in: from, len })
  }
  return out.length > 0 ? sortClips(out) : [makeClip(track, { start: 0 })]
}

async function buildTrack(src, files) {
  if (src.type === 'bg') {
    const media = await loadBackground(files[0])
    const track = {
      id: nextId('track'),
      type: 'bg',
      kind: media.kind,
      name: src.name || media.name,
      fileName: files[0].name,
      el: media.el,
      url: media.url,
      width: media.width,
      height: media.height,
      duration: media.duration,
      fit: src.fit,
      opacity: src.opacity,
      scale: src.scale,
      x: src.x,
      y: src.y,
      blend: src.blend,
      fx: src.fx,
      visible: src.visible,
      muted: src.muted,
      clips: [],
    }
    track.clips = fitClips(track, src.clips)
    return track
  }

  if (src.type === 'cell') {
    const seq = await loadCellSequence(files)
    const track = {
      id: nextId('track'),
      type: 'cell',
      name: src.name,
      files: seq.names,
      frames: seq.frames,
      width: seq.width,
      height: seq.height,
      fps: src.fps,
      opacity: src.opacity,
      scale: src.scale,
      x: src.x,
      y: src.y,
      fit: src.fit,
      blend: src.blend,
      fx: src.fx,
      visible: src.visible,
      clips: [],
    }
    track.clips = fitClips(track, src.clips)
    return track
  }

  const decoded = await decodeAudioFile(files[0])
  const track = {
    id: nextId('track'),
    type: 'audio',
    name: src.name,
    fileName: files[0].name,
    buffer: decoded.buffer,
    peaks: decoded.peaks,
    duration: decoded.duration,
    gain: src.gain,
    muted: src.muted,
    clips: [],
  }
  track.clips = fitClips(track, src.clips)
  return track
}

/**
 * シーンと、名前で引ける素材(Map: assetKey → File)からトラックを組み直す。
 * 素材が1つも見つからないレイヤーは飛ばし、その名前を skipped に入れて返す。
 */
export async function restoreScene(scene, pool, { onProgress } = {}) {
  const tracks = []
  const skipped = []
  const total = scene.tracks.length

  for (let i = 0; i < total; i++) {
    const src = scene.tracks[i]
    onProgress?.(i, total, `${src.name} を読み込み中…`)
    // セルは欠けた分を抜いたまま組む(コマ数が減るぶんはクリップ側で詰める)
    const files = src.files.map((n) => pool.get(assetKey(n))).filter(Boolean)
    if (files.length === 0) {
      skipped.push(src.name)
      continue
    }
    try {
      tracks.push(await buildTrack(src, files))
    } catch {
      skipped.push(src.name)
    }
  }
  onProgress?.(total, total, 'シーンを組み立て中…')

  return {
    tracks,
    skipped,
    stage: scene.stage,
    projectFps: scene.project.fps,
    muted: scene.project.muted,
    volume: scene.project.volume,
    name: scene.project.name,
  }
}
