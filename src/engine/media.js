const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'ogg']
const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'oga']

export const BACKGROUND_ACCEPT = [...IMAGE_EXT, ...VIDEO_EXT].map((e) => '.' + e).join(',')
export const AUDIO_ACCEPT = AUDIO_EXT.map((e) => '.' + e).join(',')

export function extOf(name) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** MIME を優先し、無ければ拡張子で判定する */
export function kindOf(file) {
  const type = file.type || ''
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  const ext = extOf(file.name)
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  return 'unknown'
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** cut01_0002.png のような連番を数値順に並べる */
export function sortByName(files) {
  return [...files].sort((a, b) => collator.compare(a.name, b.name))
}

async function walkEntry(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((res, rej) => entry.file(res, rej)))
    return
  }
  if (!entry.isDirectory) return
  const reader = entry.createReader()
  // readEntries は1回で最大100件しか返さないので空になるまで回す
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
    if (batch.length === 0) break
    for (const e of batch) await walkEntry(e, out)
  }
}

/** ドロップされた項目からファイルを取り出す(フォルダは再帰的に展開) */
export async function filesFromDataTransfer(dt) {
  // items は同期的に読まないと無効化されるため先に entry を確保する
  const entries = [...(dt.items ?? [])]
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean)
  if (entries.length === 0) return [...dt.files]

  const out = []
  try {
    for (const e of entries) await walkEntry(e, out)
  } catch {
    return [...dt.files]
  }
  return out.length > 0 ? out : [...dt.files]
}

function waitEvent(el, event, errorLabel) {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup()
      resolve()
    }
    const ng = () => {
      cleanup()
      reject(new Error(errorLabel))
    }
    const cleanup = () => {
      el.removeEventListener(event, ok)
      el.removeEventListener('error', ng)
    }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', ng, { once: true })
  })
}

/**
 * 背景素材を1つ読み込む。
 * image  … 静止画(尺は持たない)
 * video  … 映像+音声
 * audio  … 音声のみ(絵は無し。尺だけタイムラインに反映される)
 */
export async function loadBackground(file) {
  const kind = kindOf(file)
  if (kind === 'audio') {
    throw new Error('音声ファイルは音声トラックとして読み込んでください')
  }
  if (kind === 'unknown') {
    throw new Error(`対応していない形式です: ${file.name}`)
  }
  const url = URL.createObjectURL(file)
  const base = { kind, url, name: file.name }

  try {
    if (kind === 'image') {
      const el = new Image()
      el.src = url
      await (el.decode ? el.decode() : waitEvent(el, 'load', '画像を読み込めません'))
      return { ...base, el, width: el.naturalWidth, height: el.naturalHeight, duration: 0 }
    }

    if (kind === 'video') {
      const el = document.createElement('video')
      el.src = url
      el.preload = 'auto'
      el.playsInline = true
      el.crossOrigin = 'anonymous'
      await waitEvent(el, 'loadeddata', '動画を読み込めません')
      return {
        ...base,
        el,
        width: el.videoWidth,
        height: el.videoHeight,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      }
    }

    throw new Error(`対応していない形式です: ${file.name}`)
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

export function disposeBackground(bg) {
  if (!bg) return
  if (bg.el && 'pause' in bg.el) {
    bg.el.pause()
    bg.el.removeAttribute('src')
    bg.el.load?.()
  }
  URL.revokeObjectURL(bg.url)
}

/**
 * 透過PNG連番をデコードして ImageBitmap の配列にする。
 * 同時デコード数を絞ってメモリ・CPUのスパイクを避ける。
 */
export async function loadCellSequence(fileList, onProgress) {
  const files = sortByName(
    [...fileList].filter((f) => kindOf(f) === 'image'),
  )
  if (files.length === 0) throw new Error('画像ファイルが含まれていません')

  const frames = new Array(files.length)
  let done = 0
  const CONCURRENCY = 8
  let cursor = 0

  async function worker() {
    while (cursor < files.length) {
      const i = cursor++
      frames[i] = await createImageBitmap(files[i])
      done++
      onProgress?.(done, files.length)
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker),
    )
  } catch (e) {
    for (const f of frames) f?.close?.()
    throw e
  }

  return {
    frames,
    names: files.map((f) => f.name),
    width: frames[0].width,
    height: frames[0].height,
  }
}
