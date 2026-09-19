/**
 * 素材フォルダを覚えておいて、シーン JSON を開いたときに自動で結び直す。
 *
 * ブラウザは「C:\work\cutA\0001.png」のような絶対パスをアプリに渡さない。
 * その代わり、一度選んでもらったフォルダは FileSystemFileHandle として
 * IndexedDB に保存でき、次に開いたときも同じ場所を読み直せる。
 * つまり「同じ場所に素材が置いてあれば JSON だけで戻る」は、
 *   1. 素材フォルダを一度だけ覚えさせる
 *   2. JSON にはファイル名と相対パスを書いておく
 * の2つで実現できる。ここは 1 の側。
 *
 * 対応は Chrome / Edge などのデスクトップだけ。iPad Safari には
 * showDirectoryPicker が無いので、これまで通り素材を選び直す画面に落ちる。
 */
import { markPath } from './media.js'
import { assetKey, pathKey, pathScore, sceneAssets } from './scene.js'
import { canPickDirectory, idbGet, idbPut } from './saveFile.js'

const KEY = 'sourceDirs'
const MAX_FILES = 50000
const MAX_DEPTH = 12
const READ_BATCH = 16

/** 素材フォルダを覚えておけるか */
export const canRememberFolders = canPickDirectory

async function readList() {
  try {
    const v = await idbGet(KEY)
    return Array.isArray(v) ? v.filter((e) => e && e.handle) : []
  } catch {
    return []
  }
}

async function writeList(list) {
  try {
    await idbPut(
      KEY,
      list.map(({ id, name, handle }) => ({ id, name, handle })),
    )
  } catch {
    /* 覚えられなくても、その場で選べば使える */
  }
}

async function permission(handle, request) {
  try {
    const state = request
      ? await handle.requestPermission?.({ mode: 'read' })
      : await handle.queryPermission?.({ mode: 'read' })
    return state === 'granted'
  } catch {
    return false
  }
}

/** 覚えている素材フォルダ。granted が false のものは許可を取り直す必要がある */
export async function listSourceFolders() {
  const list = await readList()
  const out = []
  for (const e of list) out.push({ ...e, granted: await permission(e.handle, false) })
  return out
}

/** フォルダを選んでもらって覚える。同じフォルダなら二重に持たない */
export async function rememberSourceFolder() {
  if (!canPickDirectory()) return null
  const handle = await window.showDirectoryPicker({ id: 'piyopiyo-assets', mode: 'read' })
  const list = await readList()
  for (const e of list) {
    try {
      if (await e.handle.isSameEntry?.(handle)) return { ...e, granted: true }
    } catch {
      /* 比べられないものは新しいものとして足す */
    }
  }
  const entry = {
    id: `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: handle.name,
    handle,
  }
  await writeList([...list, entry])
  return { ...entry, granted: true }
}

export async function forgetSourceFolder(id) {
  const list = await readList()
  await writeList(list.filter((e) => e.id !== id))
}

/** 覚えているフォルダの許可を取り直す(ボタンなどユーザー操作の中から呼ぶ) */
export const requestFolderAccess = (entry) => permission(entry.handle, true)

/** フォルダの中身を再帰的に数え上げる。鍵はフォルダ名から始まる相対パス */
async function indexFolder(handle, root, out, depth = 0) {
  if (depth > MAX_DEPTH || out.size >= MAX_FILES) return out
  for await (const [name, child] of handle.entries()) {
    if (name.startsWith('.')) continue
    const path = root ? `${root}/${name}` : name
    if (child.kind === 'file') out.set(pathKey(path), { handle: child, path })
    else await indexFolder(child, path, out, depth + 1)
    if (out.size >= MAX_FILES) break
  }
  return out
}

/** 数え上げた中から、欲しい素材に一番近いものを選ぶ */
function pickEntry(index, byName, want) {
  const exact = index.get(pathKey(want.path))
  if (exact) return exact
  const list = byName.get(assetKey(want.name))
  if (!list || list.length === 0) return null
  if (list.length === 1) return list[0]

  // 同じ名前が何個もあるときは、パスの末尾が一番よく合うものを選ぶ
  let best = list[0]
  let score = -1
  for (const e of list) {
    const s = pathScore(e.path, want.path)
    if (s > score) {
      best = e
      score = s
    }
  }
  return best
}

/**
 * シーンが要求している素材を、覚えているフォルダから拾い集める。
 *   request … 許可が切れていたら取り直す(ユーザー操作の中から呼ぶこと)
 * 返り値の files は markPath 済みなので、そのまま makePool に入れられる。
 */
export async function collectFromFolders(scene, { request = false, onProgress } = {}) {
  const folders = await listSourceFolders()
  const files = []
  const blocked = []
  const used = []
  if (folders.length === 0) return { files, blocked, used, missing: sceneAssets(scene), folders }

  let remaining = sceneAssets(scene)
  const total = remaining.length

  for (const folder of folders) {
    if (remaining.length === 0) break
    let ok = folder.granted
    if (!ok && request) ok = await requestFolderAccess(folder)
    if (!ok) {
      blocked.push(folder)
      continue
    }

    onProgress?.(files.length, total, `📁 ${folder.name} を調べています…`)
    let index
    try {
      index = await indexFolder(folder.handle, folder.name, new Map())
    } catch {
      blocked.push(folder)
      continue
    }

    const byName = new Map()
    for (const e of index.values()) {
      const k = assetKey(e.path)
      const list = byName.get(k)
      if (list) list.push(e)
      else byName.set(k, [e])
    }

    const hits = []
    const next = []
    for (const want of remaining) {
      const e = pickEntry(index, byName, want)
      if (e) hits.push(e)
      else next.push(want)
    }

    // ファイルを取り出す。数が多いので少しずつ並べて読む
    for (let i = 0; i < hits.length; i += READ_BATCH) {
      const batch = hits.slice(i, i + READ_BATCH)
      const got = await Promise.all(
        batch.map(async (e) => {
          try {
            return markPath(await e.handle.getFile(), e.path)
          } catch {
            return null
          }
        }),
      )
      for (const f of got) if (f) files.push(f)
      onProgress?.(files.length, total, `📁 ${folder.name} から読み込み中…`)
    }

    if (hits.length > 0) used.push(folder.name)
    remaining = next
  }

  return { files, blocked, used, missing: remaining, folders }
}
