/**
 * 素材ごと1つにまとめたシーンファイル(.piyo)。
 *
 * 中身はただの ZIP(無圧縮)で、
 *   scene.json      … いつものシーン JSON + 素材の置き場所の対応表(bundle)
 *   assets/...      … 読み込んだ動画・画像・音声そのもの
 * が入っている。拡張子を .zip に変えれば普通に展開して素材を取り出せる。
 *
 * 動画はもともと圧縮されているので、縮めずにそのまま詰める。そのぶん
 *   ・書くときは File を Blob の部品として並べるだけ(中身をメモリに写さない)
 *   ・読むときは File.slice で切り出すだけ
 * で済み、何百 MB の動画でも軽く扱える。
 * ZIP64 には対応しないので、1つのファイルは合計 4GB 未満まで。
 */
import { markPath } from './media.js'
import { pathKey, sceneToText } from './scene.js'

export const BUNDLE_EXT = 'piyo'
export const BUNDLE_MIME = 'application/zip'
const SCENE_ENTRY = 'scene.json'
const LIMIT = 0xffffffff

/** .piyo として扱うファイルか(拡張子を見る。中身は開くときに確かめる) */
export const isBundleFile = (file) => /\.piyo$/i.test(file?.name ?? '')

/* ---------------- CRC-32 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crcUpdate(crc, bytes) {
  let c = crc
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return c
}

/** Blob を少しずつ読みながら CRC-32 を出す(丸ごとメモリに載せない) */
export async function crc32(blob, onBytes) {
  let crc = 0xffffffff
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    crc = crcUpdate(crc, value)
    onBytes?.(value.length)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/* ---------------- ZIP を書く ---------------- */

const utf8 = new TextEncoder()

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function localHeader(name, crc, size, stamp) {
  const h = new DataView(new ArrayBuffer(30))
  h.setUint32(0, 0x04034b50, true)
  h.setUint16(4, 20, true) // 展開に要る版
  h.setUint16(6, 0x0800, true) // 名前は UTF-8
  h.setUint16(8, 0, true) // 無圧縮
  h.setUint16(10, stamp.time, true)
  h.setUint16(12, stamp.day, true)
  h.setUint32(14, crc, true)
  h.setUint32(18, size, true)
  h.setUint32(22, size, true)
  h.setUint16(26, name.length, true)
  h.setUint16(28, 0, true)
  return new Uint8Array(h.buffer)
}

function centralHeader(name, crc, size, offset, stamp) {
  const h = new DataView(new ArrayBuffer(46))
  h.setUint32(0, 0x02014b50, true)
  h.setUint16(4, 20, true)
  h.setUint16(6, 20, true)
  h.setUint16(8, 0x0800, true)
  h.setUint16(10, 0, true)
  h.setUint16(12, stamp.time, true)
  h.setUint16(14, stamp.day, true)
  h.setUint32(16, crc, true)
  h.setUint32(20, size, true)
  h.setUint32(24, size, true)
  h.setUint16(28, name.length, true)
  // 30〜45: 追加欄・コメントの長さ、ディスク番号、属性は 0
  h.setUint32(42, offset, true)
  return new Uint8Array(h.buffer)
}

function endRecord(count, size, offset) {
  const h = new DataView(new ArrayBuffer(22))
  h.setUint32(0, 0x06054b50, true)
  h.setUint16(8, count, true)
  h.setUint16(10, count, true)
  h.setUint32(12, size, true)
  h.setUint32(16, offset, true)
  return new Uint8Array(h.buffer)
}

/**
 * [{ name, blob }] を無圧縮の ZIP にする。blob は部品として並べるだけで写さない。
 * onProgress(読んだバイト数, 全体のバイト数) は CRC を数えている間に呼ばれる。
 */
export async function writeZip(entries, { onProgress, date = new Date() } = {}) {
  if (entries.length > 0xffff) throw new Error('入れるファイルが多すぎます')
  const total = entries.reduce((n, e) => n + e.blob.size, 0)
  const stamp = dosTime(date)
  const parts = []
  const central = []
  let offset = 0
  let read = 0

  for (const e of entries) {
    const name = utf8.encode(e.name)
    const size = e.blob.size
    const crc = await crc32(e.blob, (n) => {
      read += n
      onProgress?.(read, total)
    })
    if (offset + 30 + name.length + size > LIMIT) {
      throw new Error('素材が大きすぎて1つのファイルにまとめられません(合計 4GB まで)')
    }
    parts.push(localHeader(name, crc, size, stamp), name, e.blob)
    central.push(centralHeader(name, crc, size, offset, stamp), name)
    offset += 30 + name.length + size
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0)
  if (offset + centralSize > LIMIT) {
    throw new Error('素材が大きすぎて1つのファイルにまとめられません(合計 4GB まで)')
  }
  return new Blob([...parts, ...central, endRecord(entries.length, centralSize, offset)], {
    type: BUNDLE_MIME,
  })
}

/* ---------------- ZIP を読む ---------------- */

const utf8Decode = new TextDecoder()

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

/**
 * 無圧縮の ZIP を開いて { name: Blob } の Map にする。中身は slice するだけ。
 * 圧縮されたものが混じっていたら投げる(このアプリが書いたものは全部無圧縮)。
 */
export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 22 + 0xffff)
  const tail = await view(blob, blob.size - tailSize, blob.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('PiyopiyoToonz のシーンファイルではありません')

  const count = tail.getUint16(eocd + 10, true)
  const cdSize = tail.getUint32(eocd + 12, true)
  const cdOffset = tail.getUint32(eocd + 16, true)
  const cd = await view(blob, cdOffset, cdOffset + cdSize)

  const out = new Map()
  let p = 0
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('シーンファイルが壊れています')
    const method = cd.getUint16(p + 10, true)
    const size = cd.getUint32(p + 20, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    const local = cd.getUint32(p + 42, true)
    const name = utf8Decode.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // フォルダの印
    if (method !== 0) throw new Error(`圧縮されたファイルは読めません: ${name}`)

    // ローカルヘッダの追加欄は中央ディレクトリと長さが違うことがあるので読み直す
    const lh = await view(blob, local, local + 30)
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('シーンファイルが壊れています')
    const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true)
    out.set(name, blob.slice(start, start + size))
  }
  return out
}

/* ---------------- シーンとまとめる ---------------- */

/** ZIP の中に置く名前。どの OS でも展開できるように、使えない字と .. を落とす */
function entryName(path, used) {
  const parts = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[:*?"<>|]/g, '').trim())
    .filter((s) => s && s !== '.' && s !== '..')
  const base = parts.length > 0 ? parts.join('/') : 'file'
  let name = `assets/${base}`
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const dot = base.lastIndexOf('.')
    const stem = dot > base.lastIndexOf('/') ? base.slice(0, dot) : base
    const ext = dot > base.lastIndexOf('/') ? base.slice(dot) : ''
    name = `assets/${stem} (${i})${ext}`
  }
  used.add(name.toLowerCase())
  return name
}

/**
 * トラックが持っている素材の実物を、シーン JSON の files / paths と同じ順で並べる。
 * { path, name, file } の配列(同じパスのものは1つに畳む)。
 * 実物が無いレイヤーがあれば、その名前を missing に入れて返す。
 */
export function trackSources(tracks) {
  const seen = new Map()
  const missing = []
  for (const t of tracks) {
    const sources = Array.isArray(t.sources) ? t.sources : []
    const names = t.type === 'cell' ? t.files ?? [] : [t.fileName ?? t.name]
    const paths = t.type === 'cell' ? t.paths ?? [] : [t.path]
    if (sources.length !== names.length || sources.some((f) => !f)) {
      missing.push(t.name)
      continue
    }
    names.forEach((name, i) => {
      const path = paths[i] || name
      const key = pathKey(path)
      if (!seen.has(key)) seen.set(key, { path, name, file: sources[i] })
    })
  }
  return { assets: [...seen.values()], missing }
}

/**
 * シーン JSON(serializeScene の結果)と素材の実物を .piyo にまとめる。
 * 素材が元の場所から消えていたりして読めなければ、そのファイル名を添えて投げる。
 */
export async function packBundle(doc, assets, { onProgress } = {}) {
  const used = new Set()
  const listed = assets.map((a) => ({ ...a, entry: entryName(a.path, used) }))
  const scene = {
    ...doc,
    // どの素材が ZIP のどこにあるか
    bundle: listed.map((a) => ({ path: a.path, name: a.name, entry: a.entry })),
  }
  const entries = [
    { name: SCENE_ENTRY, blob: new Blob([sceneToText(scene)], { type: 'application/json' }) },
    ...listed.map((a) => ({ name: a.entry, blob: a.file })),
  ]
  try {
    return await writeZip(entries, { onProgress })
  } catch (e) {
    if (e?.name === 'NotReadableError' || e?.name === 'NotFoundError') {
      throw new Error('読み込んだ素材の一部が元の場所から動いたか消えたため、まとめられませんでした')
    }
    throw e
  }
}

/**
 * .piyo を開いて、シーン JSON の文字列と素材(markPath 済みの File)を返す。
 * 素材は元のファイル名・パスに戻してあるので、そのまま makePool に入れれば結び直せる。
 */
export async function unpackBundle(blob) {
  const entries = await readZip(blob)
  const sceneBlob = entries.get(SCENE_ENTRY)
  if (!sceneBlob) throw new Error('PiyopiyoToonz のシーンファイルではありません')
  const text = await sceneBlob.text()

  let list = []
  try {
    const data = JSON.parse(text)
    list = Array.isArray(data?.bundle) ? data.bundle : []
  } catch {
    /* 読み解けないものは parseScene 側で理由を出す */
  }

  const files = []
  for (const a of list) {
    const part = a && entries.get(a.entry)
    if (!part) continue
    const name = String(a.name || a.entry.split('/').pop())
    files.push(markPath(new File([part], name), a.path || name))
  }
  return { text, files }
}
