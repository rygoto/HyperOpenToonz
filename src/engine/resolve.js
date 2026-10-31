/**
 * DaVinci Resolve に渡すためのタイムライン(FCPXML)。音声付加側で使う。
 *
 * 書き出す ZIP の中身は
 *   <名前>.fcpxml … トラック・クリップの位置と長さ・配置・音量
 *   assets/...    … 動画・画像・音声そのもの(.piyo と同じ置き方)
 * で、展開した fcpxml を Resolve の「ファイル → 読み込み → タイムライン」で開く。
 * Resolve は素材の相対パスを解決できないので、展開先のフォルダ(絶対パス)を受け取って file:// で書く。
 * ブラウザからは保存先の絶対パスが分からないため、その場所は使う人に入れてもらう。
 *
 * 置き方は FCPXML の決まりに合わせて直す。
 *   ・時間はタイムラインの fps のコマに丸める
 *   ・段(lane)ごとにクリップを gap でつないだストーリーラインにする(Resolve に段を詰めさせない)
 *   ・映像は lane 1 の1本だけ。同じ時点に重なったら一番手前のレイヤーのクリップを残し、隠れた分は切る
 *   ・音声は 台詞 → SE → BGM の順に lane -1, -2, … とタグごとにまとめる。
 *     同じタグが同時に鳴るときだけ、そのタグの段を増やす。ミュートしたトラックは入れない
 *   ・位置は画面の高さを 100 とした値で、原点は中央、上が +。回転は反時計回りが +
 * 合成モードと撮影処理(色のフィルタなど)は Resolve に同じものが無いので渡さない。
 * 参考用のトラックと非表示の映像も入れない。
 */
import { listEntries, writeAssetsZip } from './bundle.js'
import { pathKey } from './scene.js'

export const RESOLVE_EXT = 'fcpxml'
const FCPXML_VERSION = '1.8'
// 音声の段の並び(上から)。タグごとに Resolve 上のトラックがまとまる
export const RESOLVE_ROLES = ['voice', 'se', 'bgm']

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

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')

/** 相対の URL。区切りごとに % で包む */
const relUrl = (entry) => './' + encodePath(entry)

/** 絶対パスらしいか(C:\… / \\サーバ\… / /Users/…) */
export const isAbsoluteDir = (dir) => /^([A-Za-z]:[\\/]|[\\/])/.test(String(dir ?? '').trim())

/** フォルダの絶対パスを file:// の URL に。Windows の区切り(\)も受け付ける */
export function fileUrl(dir) {
  const p = String(dir).trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:/.test(p)) return 'file:///' + p.slice(0, 2) + encodePath(p.slice(2))
  if (p.startsWith('//')) return 'file:' + encodePath(p)
  return 'file://' + encodePath(p.startsWith('/') ? p : '/' + p)
}

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
 * root(fcpxml を置くフォルダの絶対パス)があれば素材を file:// で、無ければ相対で指す。
 * 映すクリップが1つも無ければ投げる。
 */
export function buildFcpxml(doc, listed, { root } = {}) {
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
      src: root ? `${fileUrl(root)}/${encodePath(entry)}` : relUrl(entry),
    })
    resources.push(`<asset${head}/>`)
    assets.set(entry, a)
    return a
  }

  const clips = []
  let end = 0

  // クリップの位置・素材の頭・長さをコマで。素材の尻を越えた分は映すものが無いので切る
  const span = (t, a, c) => {
    const startF = frames(c.start)
    const inF = a.isImage ? 0 : frames(c.in)
    let lenF = frames(c.start + c.len) - startF
    if (!a.isImage && a.dur > 0) lenF = Math.min(lenF, Math.floor((a.dur - c.in) * fps + 1e-6))
    return { startF, inF, lenF }
  }
  // 段(lane)ごとに置くクリップ。xml は段の中での位置が決まってから作る
  const put = (lane, t, a, at, inF, len, tag, extra, inner) => {
    end = Math.max(end, at + len)
    clips.push({ lane, at, inF, len, image: a.isImage, tag, extra, inner, ref: a.id, name: t.name })
  }

  // 映像は1本にまとめる。同じ時点に重なったら一番手前(並びの後ろ)のレイヤーだけを残す。
  // 隠れた部分は切り落とすので、透過や縮小で後ろが見えていても後ろのクリップは入らない
  const covered = []
  const videoTracks = tracks.filter((t) => t.type === 'bg' && t.visible !== false)
  for (const t of [...videoTracks].reverse()) {
    const a = assetFor(t)
    const own = []
    for (const c of t.clips ?? []) {
      const { startF, inF, lenF } = span(t, a, c)
      if (lenF <= 0) continue
      for (const [s, e] of uncovered(covered, startF, startF + lenF)) {
        const inS = a.isImage ? 0 : inF + (s - startF)
        if (a.isImage) {
          put(1, t, a, s, inS, e - s, 'video', {}, videoParams(t, cw, ch))
        } else {
          const inner = [...videoParams(t, cw, ch), ...(t.muted ? [] : volumeParam(t.gain * master))]
          put(1, t, a, s, inS, e - s, 'asset-clip', { srcEnable: t.muted ? 'video' : undefined }, inner)
        }
      }
      own.push([startF, startF + lenF])
    }
    // 同じレイヤーのクリップどうしは隠し合わないので、レイヤーを見終えてから足す
    for (const r of own) addRange(covered, r)
  }

  // 音声はタグ(台詞・SE・BGM)ごとにまとめる。ミュートしたトラックは入れない。
  // 同じタグで同時に鳴るものがあれば、そのタグの段を増やして重ならないように振り分ける
  let audioLane = 0
  for (const role of RESOLVE_ROLES) {
    const items = []
    for (const t of tracks) {
      if (t.type !== 'audio' || t.muted || roleOf(t) !== role) continue
      const a = assetFor(t)
      for (const c of t.clips ?? []) {
        const { startF, inF, lenF } = span(t, a, c)
        if (lenF > 0) items.push({ t, a, startF, inF, lenF })
      }
    }
    items.sort((x, y) => x.startF - y.startF)
    const ends = []
    for (const it of items) {
      let k = ends.findIndex((e) => e <= it.startF)
      if (k < 0) k = ends.push(0) - 1
      ends[k] = it.startF + it.lenF
      put(-(audioLane + k + 1), it.t, it.a, it.startF, it.inF, it.lenF, 'asset-clip', {}, volumeParam(it.t.gain * master))
    }
    audioLane += ends.length
  }
  if (end <= 0) throw new Error('タイムラインにクリップがありません')

  // 段ごとに、クリップを隙間(gap)でつないだ1本のストーリーラインにする。
  // ばらばらに置くと Resolve は時間の被らないクリップを空いた段へ詰めてしまうが、
  // 0秒から始まる1本のかたまりにしておけば段がそのまま Resolve のトラックになる
  const lanes = [...new Set(clips.map((c) => c.lane))].sort((x, y) => (x > 0) - (y > 0) || Math.abs(x) - Math.abs(y))
  const storylines = lanes.map((lane) => {
    const items = clips.filter((c) => c.lane === lane).sort((x, y) => x.at - y.at)
    const out = []
    let at = 0
    for (const c of items) {
      // 同じ段で重なった分(同じレイヤーのクリップどうし)は、後のクリップの頭を切る
      const cut = Math.max(0, at - c.at)
      if (cut >= c.len) continue
      const from = c.at + cut
      if (from > at) out.push(`<gap${attrs({ name: 'Gap', offset: timeOf(at, fd), start: '0s', duration: timeOf(from - at, fd) })}/>`)
      const a = {
        ref: c.ref,
        offset: timeOf(from, fd),
        name: c.name,
        start: timeOf(c.image ? 0 : c.inF + cut, fd),
        duration: timeOf(c.len - cut, fd),
        ...c.extra,
      }
      out.push(element(c.tag, a, c.inner))
      at = from + c.len - cut
    }
    return element('spine', { lane, offset: '0s' }, out)
  })

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
    ...storylines.map((x) => x.replace(/^/gm, '              ')),
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

/** タグの無い音声(アニメーション側で読んだものなど)は SE として扱う */
const roleOf = (t) => (RESOLVE_ROLES.includes(t.role) ? t.role : 'se')

/** [from, to) のうち、covered(並んだ区間)に入っていない部分 */
export function uncovered(covered, from, to) {
  const out = []
  let at = from
  for (const [s, e] of covered) {
    if (e <= at) continue
    if (s >= to) break
    if (s > at) out.push([at, s])
    at = Math.max(at, e)
    if (at >= to) break
  }
  if (at < to) out.push([at, to])
  return out
}

/** covered に区間を足す(並びと重なりのまとめを保つ) */
function addRange(covered, [from, to]) {
  covered.push([from, to])
  covered.sort((x, y) => x[0] - y[0])
  const merged = []
  for (const r of covered) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  covered.splice(0, covered.length, ...merged)
}

function element(tag, a, children) {
  if (children.length === 0) return `<${tag}${attrs(a)}/>`
  return [`<${tag}${attrs(a)}>`, ...children.map((c) => '  ' + c), `</${tag}>`].join('\n')
}

/**
 * FCPXML と素材の実物を1つの ZIP にまとめる。fcpxml は ZIP の一番上に name.fcpxml として置く。
 * assets は trackSources の結果(書き出しに入るトラックの分だけ渡す)。
 * root は展開したあと fcpxml が置かれるフォルダの絶対パス(buildFcpxml を参照)。
 */
export async function packResolve(doc, assets, name, { onProgress, root } = {}) {
  const listed = listEntries(assets)
  const xml = buildFcpxml(doc, listed, { root })
  return writeAssetsZip(
    [
      { name: `${name}.${RESOLVE_EXT}`, blob: new Blob([xml], { type: 'application/xml' }) },
      ...listed.map((a) => ({ name: a.entry, blob: a.file })),
    ],
    { onProgress },
  )
}
