/**
 * DaVinci Resolve に渡すためのタイムライン(FCPXML)。音声付加側で使う。
 *
 * 書き出す ZIP の中身は
 *   <名前>.fcpxml … トラック・クリップの位置と長さ・配置・音量
 *   assets/...    … 動画・画像・音声そのもの(.piyo と同じ置き方)
 * で、展開した fcpxml を Resolve の「ファイル → 読み込み → タイムライン」で開く。
 *
 * 置き方は FCPXML の決まりに合わせて直す。
 *   ・時間はタイムラインの fps のコマに丸める
 *   ・映像トラックは重なり順のまま lane 1, 2, …(大きいほど手前)、音声トラックは lane -1, -2, …
 *   ・位置は画面の高さを 100 とした値で、原点は中央、上が +。回転は反時計回りが +
 * 合成モードと撮影処理(色のフィルタなど)は Resolve に同じものが無いので渡さない。
 * 参考用のトラックは書き出しと同じく入れない。
 */
import { listEntries, writeAssetsZip } from './bundle.js'
import { pathKey } from './scene.js'

export const RESOLVE_EXT = 'fcpxml'
const FCPXML_VERSION = '1.8'

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('')

const n = (v, digits = 4) => {
  const x = Math.round(Number(v) * 10 ** digits) / 10 ** digits
  return Object.is(x, -0) ? 0 : x
}

/** 1コマの長さを分数で。23.976 などは 1001 で割る形にする */
export function frameDuration(fps) {
  const f = Number(fps) > 0 ? Number(fps) : 24
  const k = Math.round((f * 1001) / 1000)
  if (Math.abs(f - (k * 1000) / 1001) < 0.005 && Math.abs(f - Math.round(f)) > 0.005) {
    return { num: 1001, den: k * 1000 }
  }
  if (Math.abs(f - Math.round(f)) < 1e-6) return { num: 1, den: Math.round(f) }
  return { num: 100, den: Math.round(f * 100) }
}

/** FCPXML の時間(コマ数 × 1コマ) */
function timeOf(frames, fd) {
  if (!frames) return '0s'
  const a = frames * fd.num
  return fd.num === 1 && fd.den === 1 ? `${a}s` : `${a}/${fd.den}s`
}

/** 音量(倍率)を dB に。0 は聞こえない扱いにする */
export function gainDb(gain) {
  const g = Number(gain)
  if (!(g > 0)) return -96
  return Math.max(-96, 20 * Math.log10(g))
}

/** 相対の URL。区切りごとに % で包む */
const relUrl = (entry) => './' + entry.split('/').map(encodeURIComponent).join('/')

/** fit を Resolve のはめ込み方に。fill(引き伸ばし)は fit にして縦横の拡大率で合わせる */
function conformOf(t, sw, sh, cw, ch) {
  if (t.fit === 'cover') return { type: 'fill', sx: 1, sy: 1 }
  if (t.fit === 'none') return { type: 'none', sx: 1, sy: 1 }
  if (t.fit === 'fill' && sw > 0 && sh > 0) {
    const s = Math.min(cw / sw, ch / sh)
    return { type: 'fit', sx: cw / (sw * s), sy: ch / (sh * s) }
  }
  return { type: 'fit', sx: 1, sy: 1 }
}

function videoParams(t, cw, ch) {
  const sw = t.source?.width
  const sh = t.source?.height
  const c = conformOf(t, sw, sh, cw, ch)
  const scale = t.scale > 0 ? t.scale : 1
  const sx = c.sx * scale * (t.flipX ? -1 : 1)
  const sy = c.sy * scale
  const out = [`<adjust-conform type="${c.type}"/>`]
  const transform = {
    position: t.x || t.y ? `${n((t.x / ch) * 100)} ${n((-t.y / ch) * 100)}` : undefined,
    scale: sx !== 1 || sy !== 1 ? `${n(sx)} ${n(sy)}` : undefined,
    rotation: t.rotate ? n(-t.rotate, 3) : undefined,
  }
  if (Object.values(transform).some((v) => v !== undefined)) out.push(`<adjust-transform${attrs(transform)}/>`)
  const opacity = Number.isFinite(t.opacity) ? t.opacity : 1
  if (opacity < 1) out.push(`<adjust-blend amount="${n(opacity)}"/>`)
  return out
}

function volumeParam(gain) {
  const db = gainDb(gain)
  return Math.abs(db) < 0.005 ? [] : [`<adjust-volume amount="${n(db, 2)}dB"/>`]
}

/**
 * シーン JSON(serializeScene の結果)と、listEntries で付けた素材の置き場所から FCPXML を作る。
 * 映すクリップが1つも無ければ投げる。
 */
export function buildFcpxml(doc, listed) {
  const fps = doc.project?.exportFps || doc.project?.fps || 24
  const fd = frameDuration(fps)
  const frames = (sec) => Math.round(Math.max(0, Number(sec) || 0) * fps)
  const cw = doc.stage?.width || 1920
  const ch = doc.stage?.height || 1080
  const master = Number.isFinite(doc.project?.volume) ? doc.project.volume : 1
  const entryOf = new Map(listed.map((a) => [pathKey(a.path), a.entry]))

  const tracks = (doc.tracks ?? []).filter((t) => (t.type === 'bg' || t.type === 'audio') && !t.reference)
  const resources = [`<format id="r1"${attrs({ frameDuration: timeOf(1, fd), width: cw, height: ch })}/>`]
  const assets = new Map()
  let nextRes = 2

  const assetFor = (t) => {
    const path = t.paths?.[0] || t.files?.[0]
    const entry = entryOf.get(pathKey(path))
    if (!entry) throw new Error(`素材の実物が見つかりません: ${t.name}`)
    if (assets.has(entry)) return assets.get(entry)
    const isVideo = t.type === 'bg' && t.kind === 'video'
    const isImage = t.type === 'bg' && !isVideo
    const dur = Number(t.source?.duration) || 0
    let format
    if (t.type === 'bg') {
      format = `r${nextRes++}`
      resources.push(`<format id="${format}"${attrs({ width: t.source?.width, height: t.source?.height })}/>`)
    }
    const id = `r${nextRes++}`
    const a = { id, isImage, dur }
    const head = attrs({
      id,
      name: t.files?.[0] || t.name,
      start: '0s',
      duration: isImage ? '0s' : timeOf(Math.ceil(dur * fps - 1e-6), fd),
      hasVideo: t.type === 'bg' ? 1 : undefined,
      format,
      hasAudio: t.type === 'audio' || isVideo ? 1 : undefined,
      audioSources: t.type === 'audio' || isVideo ? 1 : undefined,
      audioChannels: t.type === 'audio' || isVideo ? 2 : undefined,
      audioRate: t.type === 'audio' || isVideo ? 48000 : undefined,
      src: relUrl(entry),
    })
    resources.push(`<asset${head}/>`)
    assets.set(entry, a)
    return a
  }

  const clips = []
  let end = 0
  let videoLane = 0
  let audioLane = 0
  for (const t of tracks) {
    const lane = t.type === 'bg' ? ++videoLane : --audioLane
    const a = assetFor(t)
    for (const c of t.clips ?? []) {
      const startF = frames(c.start)
      const inF = a.isImage ? 0 : frames(c.in)
      let lenF = frames(c.start + c.len) - startF
      // 素材の尻を越えた分は映すものが無いので切る
      if (!a.isImage && a.dur > 0) lenF = Math.min(lenF, Math.floor((a.dur - c.in) * fps + 1e-6))
      if (lenF <= 0) continue
      end = Math.max(end, startF + lenF)

      const base = {
        ref: a.id,
        lane,
        offset: timeOf(startF, fd),
        name: t.name,
        start: timeOf(inF, fd),
        duration: timeOf(lenF, fd),
      }
      if (t.type === 'audio') {
        const inner = volumeParam(t.gain * master)
        clips.push(element('asset-clip', { ...base, enabled: t.muted ? 0 : undefined }, inner))
      } else if (a.isImage) {
        clips.push(element('video', { ...base, enabled: t.visible === false ? 0 : undefined }, videoParams(t, cw, ch)))
      } else {
        const inner = [...videoParams(t, cw, ch), ...(t.muted ? [] : volumeParam(t.gain * master))]
        const off = { enabled: t.visible === false ? 0 : undefined, srcEnable: t.muted ? 'video' : undefined }
        clips.push(element('asset-clip', { ...base, ...off }, inner))
      }
    }
  }
  if (end <= 0) throw new Error('タイムラインにクリップがありません')

  const title = doc.project?.name || 'PiyopiyoToonz'
  const total = timeOf(end, fd)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    `<fcpxml version="${FCPXML_VERSION}">`,
    '  <resources>',
    ...resources.map((r) => '    ' + r),
    '  </resources>',
    '  <library>',
    `    <event${attrs({ name: title })}>`,
    `      <project${attrs({ name: title })}>`,
    `        <sequence${attrs({ format: 'r1', duration: total, tcStart: '0s', tcFormat: 'NDF', audioLayout: 'stereo', audioRate: '48k' })}>`,
    '          <spine>',
    `            <gap${attrs({ name: 'Gap', offset: '0s', start: '0s', duration: total })}>`,
    ...clips.map((c) => c.replace(/^/gm, '              ')),
    '            </gap>',
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n')
}

function element(tag, a, children) {
  if (children.length === 0) return `<${tag}${attrs(a)}/>`
  return [`<${tag}${attrs(a)}>`, ...children.map((c) => '  ' + c), `</${tag}>`].join('\n')
}

/**
 * FCPXML と素材の実物を1つの ZIP にまとめる。fcpxml は ZIP の一番上に name.fcpxml として置く。
 * assets は trackSources の結果(書き出しに入るトラックの分だけ渡す)。
 */
export async function packResolve(doc, assets, name, { onProgress } = {}) {
  const listed = listEntries(assets)
  const xml = buildFcpxml(doc, listed)
  return writeAssetsZip(
    [
      { name: `${name}.${RESOLVE_EXT}`, blob: new Blob([xml], { type: 'application/xml' }) },
      ...listed.map((a) => ({ name: a.entry, blob: a.file })),
    ],
    { onProgress },
  )
}
