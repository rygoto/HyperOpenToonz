/**
 * シーン(プロジェクト)を JSON に書き出す / JSON からシーンを組み直す。
 *
 * 入れるもの … レイヤーの構成・重なり順・配置・合成・撮影処理・クリップ・
 *              ステージ設定・プロジェクト fps・音量、そして素材のファイル名とパス
 * 入れないもの … 絵と音そのもの(画素と波形)
 *
 * 連番セルを丸ごと抱えると JSON が何百 MB にもなってしまうので、素材は
 * 「どこの何という名前だったかを覚えておいて、読み込むときに結び直す」形にしている。
 * ブラウザは絶対パスを教えてくれないので、覚えるのは
 *   ・ファイル名
 *   ・分かる範囲の相対パス(フォルダごと読み込んだとき / 覚えたフォルダから開いたとき)
 * の2つ。素材フォルダを覚えさせてあれば、この2つだけで自動的に結び直せる。
 */
import { decodeAudioFile, decodeVideoAudio } from './audio.js'
import { normalizeFx } from './fx.js'
import { normalizeMode } from '../modes.js'
import { nextId } from './ids.js'
import { filePath, loadBackground, loadCellSequence } from './media.js'
import { makeClip, minUnits, sortClips, sourceUnits } from './timeline.js'

export const SCENE_APP = 'PiyopiyoToonz'
export const SCENE_KIND = 'scene'
export const SCENE_VERSION = 2
export const SCENE_EXT = 'json'

/** 素材を名前で結び直すときの鍵(大文字小文字とパスの違いは無視する) */
export const assetKey = (name) => String(name ?? '').split(/[\\/]/).pop().toLowerCase()

/** 素材をパスで結び直すときの鍵(区切りと大文字小文字を揃える) */
export const pathKey = (path) =>
  String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .toLowerCase()

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
  rotate: r(t.rotate ?? 0, 3),
  x: r(t.x),
  y: r(t.y),
  blend: str(t.blend, 'source-over'),
  visible: t.visible !== false,
})

/** 覚えている素材の名前とパス。パスが分からないものはファイル名で埋める */
function assetsJson(names, paths) {
  const files = names.map((n) => String(n ?? ''))
  const list = Array.isArray(paths) ? paths : []
  return {
    files,
    paths: files.map((n, i) => str(list[i], n)),
  }
}

function trackJson(t) {
  const clips = t.clips.map(clipJson)

  if (t.type === 'bg') {
    return {
      type: 'bg',
      kind: t.kind,
      name: t.name,
      ...assetsJson([t.fileName ?? t.name], [t.path]),
      source: { width: t.width, height: t.height, duration: r(t.duration) },
      ...placeJson(t),
      muted: !!t.muted,
      gain: r(t.gain ?? 1),
      fx: normalizeFx(t.fx),
      clips,
    }
  }

  if (t.type === 'cell') {
    return {
      type: 'cell',
      name: t.name,
      ...assetsJson(t.files ?? [], t.paths),
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
      ...assetsJson([t.fileName ?? t.name], [t.path]),
      source: { duration: r(t.duration) },
      ...(t.role ? { role: t.role } : {}),
      gain: r(t.gain),
      muted: !!t.muted,
      clips,
    }
  }

  return null
}

export function serializeScene({ tracks, stage, projectFps, exportFps, muted, volume, name, folders, mode }) {
  return {
    app: SCENE_APP,
    kind: SCENE_KIND,
    version: SCENE_VERSION,
    // どちらのアプリで作ったか(anime = アニメーション / sound = 音声付加)
    mode: normalizeMode(mode),
    savedAt: new Date().toISOString(),
    project: {
      name: str(name),
      fps: num(projectFps, 24),
      // 書き出す動画の fps(プロジェクト fps とは別に決められる)
      exportFps: num(exportFps, 24),
      muted: !!muted,
      volume: r(volume),
    },
    // 素材を置いてあるフォルダの名前(次に開くときの手がかり。中身は入れない)
    folders: (Array.isArray(folders) ? folders : []).map((f) => str(f?.name ?? f)).filter(Boolean),
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
    rotate: num(t.rotate, 0),
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
  // 版1の JSON にはパスが無い。そのときはファイル名で代用する
  const stored = Array.isArray(t.paths) ? t.paths : []
  const paths = files.map((n, k) => str(stored[k], n))
  const clips = Array.isArray(t.clips) ? t.clips.map(clipIn) : []
  const name = str(t.name, `レイヤー${i + 1}`)

  if (t.type === 'bg') {
    return {
      type: 'bg',
      kind: str(t.kind, 'image'),
      name,
      files,
      paths,
      clips,
      muted: !!t.muted,
      gain: Math.max(0, num(t.gain, 1)),
      fx: normalizeFx(t.fx),
      ...placeIn(t),
    }
  }
  if (t.type === 'cell') {
    return { type: 'cell', name, files, paths, clips, fps: Math.max(1, num(t.fps, 8)), fx: normalizeFx(t.fx), ...placeIn(t) }
  }
  if (t.type === 'audio') {
    const role = t.role === 'bgm' || t.role === 'se' ? t.role : undefined
    return { type: 'audio', name, files, paths, clips, role, gain: Math.max(0, num(t.gain, 1)), muted: !!t.muted }
  }
  return null
}

/**
 * 保存した JSON を読み解く。形が違えば理由を添えて投げる。
 * 返るのは「素材を結び直す前」のシーン(files / paths は名前のまま)。
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
    // mode の無い JSON はアニメーション側のもの
    mode: normalizeMode(data.mode),
    savedAt: str(data.savedAt),
    folders: (Array.isArray(data.folders) ? data.folders : []).map((f) => str(f)).filter(Boolean),
    project: {
      name: str(project.name),
      fps: Math.max(1, num(project.fps, 24)),
      exportFps: Math.min(120, Math.max(1, Math.round(num(project.exportFps, 24)))),
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

/* ---------------- 素材の引き当て ---------------- */

/** パスの末尾から何段ぶん一致しているか。同じ名前が複数あるときの決め手にする */
export function pathScore(a, b) {
  const x = pathKey(a).split('/')
  const y = pathKey(b).split('/')
  let n = 0
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++
  return n
}

/** 名前でもパスでも引ける素材の入れ物をつくる */
export function makePool(files = []) {
  return addToPool({ byPath: new Map(), byName: new Map() }, files)
}

/** 入れ物に素材を足す(同じパスのものは後勝ち) */
export function addToPool(pool, files = []) {
  for (const f of files) {
    if (!f) continue
    pool.byPath.set(pathKey(filePath(f)), f)
    const key = assetKey(f.name)
    const list = pool.byName.get(key)
    if (!list) pool.byName.set(key, [f])
    else if (!list.includes(f)) list.push(f)
  }
  return pool
}

export const poolSize = (pool) => pool?.byPath.size ?? 0

/**
 * 入れ物から素材を1つ探す。
 * パスがそのまま合えばそれ。駄目ならファイル名で探し、同名が複数あれば
 * パスの末尾が一番よく合うものを選ぶ。
 */
export function poolFind(pool, name, path) {
  if (!pool) return null
  const want = path || name
  const exact = pool.byPath.get(pathKey(want))
  if (exact) return exact

  const list = pool.byName.get(assetKey(name))
  if (!list || list.length === 0) return null
  if (list.length === 1) return list[0]

  let best = list[0]
  let bestScore = -1
  for (const f of list) {
    const score = pathScore(filePath(f), want)
    if (score > bestScore) {
      best = f
      bestScore = score
    }
  }
  return best
}

/** シーンが必要としている素材(重複は畳む)。{ name, path } の配列 */
export function sceneAssets(scene) {
  const out = new Map()
  for (const t of scene.tracks) {
    t.files.forEach((name, i) => {
      const path = t.paths?.[i] ?? name
      const key = pathKey(path)
      if (!out.has(key)) out.set(key, { name, path })
    })
  }
  return [...out.values()]
}

/** シーンが必要としている素材のファイル名 */
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
  track.files.forEach((name, i) => {
    if (poolFind(pool, name, track.paths?.[i])) n++
  })
  return n
}

/** どのレイヤーの素材も1つ残らず揃っているか */
export function poolCoversScene(scene, pool) {
  return scene.tracks.every((t) => foundCount(t, pool) === t.files.length)
}

/* ---------------- 組み直し ---------------- */

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

async function buildTrack(src, files, mode) {
  if (src.type === 'bg') {
    const media = await loadBackground(files[0])
    // 音声付加側の動画は、音を取り出して Web Audio で鳴らす(ゲインと波形のため)
    const sound = mode === 'sound' && media.kind === 'video' ? await decodeVideoAudio(files[0]) : null
    const track = {
      id: nextId('track'),
      type: 'bg',
      kind: media.kind,
      name: src.name || media.name,
      fileName: files[0].name,
      path: filePath(files[0]),
      el: media.el,
      url: media.url,
      width: media.width,
      height: media.height,
      duration: media.duration,
      fit: src.fit,
      opacity: src.opacity,
      scale: src.scale,
      rotate: src.rotate,
      x: src.x,
      y: src.y,
      blend: src.blend,
      fx: src.fx,
      visible: src.visible,
      muted: src.muted,
      gain: src.gain ?? 1,
      buffer: sound?.buffer ?? null,
      peaks: sound?.peaks ?? null,
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
      paths: seq.paths,
      frames: seq.frames,
      width: seq.width,
      height: seq.height,
      fps: src.fps,
      opacity: src.opacity,
      scale: src.scale,
      rotate: src.rotate,
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
    path: filePath(files[0]),
    buffer: decoded.buffer,
    peaks: decoded.peaks,
    duration: decoded.duration,
    role: src.role,
    gain: src.gain,
    muted: src.muted,
    clips: [],
  }
  track.clips = fitClips(track, src.clips)
  return track
}

/**
 * シーンと、名前やパスで引ける素材(makePool でつくった入れ物)からトラックを組み直す。
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
    const files = src.files.map((n, k) => poolFind(pool, n, src.paths?.[k])).filter(Boolean)
    if (files.length === 0) {
      skipped.push(src.name)
      continue
    }
    try {
      tracks.push(await buildTrack(src, files, scene.mode))
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
    exportFps: scene.project.exportFps,
    muted: scene.project.muted,
    volume: scene.project.volume,
    name: scene.project.name,
  }
}
