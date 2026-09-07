/** iPad / iPhone（デスクトップ表示の iPadOS を含む） */
export function isIPadLike() {
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** フォルダを覚えておけるか(Chrome / Edge などのデスクトップ) */
export const canPickDirectory = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** 保存ダイアログで場所と名前を決められるか */
export const canPickSaveFile = () => typeof window !== 'undefined' && 'showSaveFilePicker' in window

/** ファイル名に使えない文字を落とす。拡張子は呼び出し側で足す */
export function sanitizeFilename(name, fallback = 'PiyopiyoToonz') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return cleaned || fallback
}

export function withExtension(base, ext) {
  const clean = sanitizeFilename(base)
  return clean.toLowerCase().endsWith('.' + ext) ? clean : `${clean}.${ext}`
}

/* ---------- 保存先フォルダの記憶 ---------- */

const DB_NAME = 'piyopiyo'
const STORE = 'handles'
const DIR_KEY = 'exportDir'

function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no-idb'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key, value) {
  const db = await idb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function idbGet(key) {
  const db = await idb()
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return value
}

async function idbDelete(key) {
  const db = await idb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/** 保存先フォルダを選んでもらう。次回以降も同じ場所に出せるよう覚えておく */
export async function pickExportDirectory() {
  if (!canPickDirectory()) return null
  const handle = await window.showDirectoryPicker({ id: 'piyopiyo-export', mode: 'readwrite' })
  try {
    await idbPut(DIR_KEY, handle)
  } catch {
    /* 覚えられなくても今回の書き出しには使える */
  }
  return { handle, name: handle.name, granted: true }
}

/**
 * 前に選んだフォルダを取り出す。{ handle, name, granted } か null。
 * granted が false のときは、ユーザー操作の中で許可を取り直す必要がある。
 */
export async function loadExportDirectory() {
  if (!canPickDirectory()) return null
  try {
    const handle = await idbGet(DIR_KEY)
    if (!handle) return null
    const state = await handle.queryPermission?.({ mode: 'readwrite' })
    return { handle, name: handle.name, granted: state === 'granted' }
  } catch {
    return null
  }
}

/** 覚えているフォルダの許可を取り直す(ボタンなどユーザー操作の中から呼ぶ) */
export async function reauthorizeDirectory(handle) {
  try {
    const state = await handle.requestPermission?.({ mode: 'readwrite' })
    return state === 'granted'
  } catch {
    return false
  }
}

export async function forgetExportDirectory() {
  try {
    await idbDelete(DIR_KEY)
  } catch {
    /* noop */
  }
}

/** 同じ名前があったら「名前 (2).mp4」にずらす。既存ファイルは壊さない */
async function uniqueName(dir, filename) {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let name = filename
  for (let i = 2; i < 1000; i++) {
    try {
      await dir.getFileHandle(name)
    } catch {
      return name // 見つからない = 空いている
    }
    name = `${base} (${i})${ext}`
  }
  return name
}

async function writeToDirectory(dir, blob, filename) {
  const name = await uniqueName(dir, filename)
  const handle = await dir.getFileHandle(name, { create: true })
  const stream = await handle.createWritable()
  await stream.write(blob)
  await stream.close()
  return { how: 'folder', name, folder: dir.name }
}

/**
 * 書き出した Blob を保存する。
 *   dir      … 覚えている保存先フォルダ。あればそこへ直接書く
 *   askWhere … 保存ダイアログで毎回場所を選ぶ
 * iPad は共有シート、それ以外はダウンロード。どれもユーザー操作の直後に呼ぶこと。
 */
export async function saveBlob(blob, filename, { dir = null, askWhere = false } = {}) {
  const name = sanitizeFilename(filename, 'PiyopiyoToonz.mp4')

  if (dir) {
    try {
      return await writeToDirectory(dir, blob, name)
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
        // 権限切れ。下のダイアログ / ダウンロードへ落とす
      } else {
        throw e
      }
    }
  }

  if (askWhere && canPickSaveFile()) {
    const ext = name.slice(name.lastIndexOf('.'))
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: '動画', accept: { [blob.type || 'video/mp4']: [ext] } }],
      })
      const stream = await handle.createWritable()
      await stream.write(blob)
      await stream.close()
      return { how: 'picker', name: handle.name }
    } catch (e) {
      if (e?.name === 'AbortError') return { how: 'cancelled' }
      throw e
    }
  }

  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
  if (isIPadLike() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name })
      return { how: 'shared', name }
    } catch (e) {
      if (e?.name === 'AbortError') return { how: 'cancelled' }
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 8000)
  return { how: 'downloaded', name }
}

export function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}
