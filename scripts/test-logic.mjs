/**
 * 合成・編集に関わる純粋ロジックの確認。
 *   node --test scripts/test-logic.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { composite, fitRect, placeRect, trackRectAt } from '../src/engine/compositor.js'
import {
  applyPreset,
  buildLut,
  channelLuts,
  defaultFx,
  fxKey,
  hasFx,
  isIdentityLut,
  normalizeFx,
  renderFx,
} from '../src/engine/fx.js'
import { sanitizeFilename, withExtension } from '../src/engine/saveFile.js'
import {
  assetKey,
  foundCount,
  parseScene,
  sceneAssetNames,
  sceneToText,
  serializeScene,
} from '../src/engine/scene.js'
import { createClock } from '../src/engine/clock.js'
import {
  activeClip,
  bgSourceTime,
  cellFrameIndex,
  clipEndSec,
  clipLenSec,
  makeClip,
  offsetClipsTo,
  projectDurationSec,
  repeatToFill,
  sourceUnits,
  splitClip,
  trackEndSec,
  trimClipEnd,
  trimClipStart,
} from '../src/engine/timeline.js'

const cellTrack = (over = {}) => ({
  id: 't1',
  type: 'cell',
  frames: new Array(8),
  fps: 8,
  visible: true,
  opacity: 1,
  scale: 1,
  x: 0,
  y: 0,
  fit: 'contain',
  blend: 'source-over',
  width: 100,
  height: 100,
  clips: [],
  ...over,
})

const bgTrack = (over = {}) => ({
  id: 'b1',
  type: 'bg',
  kind: 'image',
  el: 'BG',
  width: 100,
  height: 100,
  duration: 0,
  visible: true,
  muted: false,
  opacity: 1,
  scale: 1,
  x: 0,
  y: 0,
  fit: 'contain',
  blend: 'source-over',
  clips: [],
  ...over,
})

const audioTrack = (over = {}) => ({
  id: 'a1',
  type: 'audio',
  duration: 10,
  gain: 1,
  muted: false,
  clips: [],
  ...over,
})

const whole = (t) => makeClip(t, { start: 0 })

test('セルの fps だけがコマ番号を決める(背景の fps とは無関係)', () => {
  const t = cellTrack()
  const c = whole(t)
  const seen = []
  for (let f = 0; f < 24; f++) seen.push(cellFrameIndex(t, c, f / 24))
  assert.deepEqual(seen, [
    0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3,
    4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7,
  ])
})

test('クリップの外は null', () => {
  const t = cellTrack()
  const c = makeClip(t, { start: 2 })
  assert.equal(cellFrameIndex(t, c, 1.9), null)
  assert.equal(cellFrameIndex(t, c, 2), 0)
  assert.equal(cellFrameIndex(t, c, 2.125), 1)
  assert.equal(cellFrameIndex(t, c, 3), null) // 8コマ/8fps = 1.0秒ぶん
})

test('分割: 位置がそのまま保たれ、後半は素材の途中から始まる', () => {
  const t = cellTrack()
  const c = whole(t)
  const [a, b] = splitClip(t, c, 0.5)
  assert.equal(a.start, 0)
  assert.equal(a.len, 4)
  assert.equal(b.start, 0.5)
  assert.equal(b.in, 4)
  assert.equal(b.len, 4)
  // 分割しても見えるコマは変わらない
  assert.equal(cellFrameIndex(t, c, 0.6), cellFrameIndex(t, b, 0.6))
  assert.equal(clipEndSec(t, b), 1)
})

test('分割: コマ境界でない位置でもズレない', () => {
  const t = cellTrack({ fps: 8 })
  const c = whole(t)
  const at = 5 / 24 // 24fps の 5 コマ目 = 8fps のコマ途中
  const [, b] = splitClip(t, c, at)
  assert.equal(b.start, at)
  assert.equal(cellFrameIndex(t, c, at), cellFrameIndex(t, b, at))
  assert.equal(cellFrameIndex(t, c, 0.9), cellFrameIndex(t, b, 0.9))
})

test('分割: 端すぎる位置では割らない', () => {
  const t = cellTrack()
  const c = whole(t)
  assert.equal(splitClip(t, c, 0), null)
  assert.equal(splitClip(t, c, 1), null)
  assert.equal(splitClip(t, c, 0.05), null) // 1コマ未満
})

test('トリム: 素材の範囲を超えない', () => {
  const t = cellTrack()
  const c = whole(t)
  const head = trimClipStart(t, c, 0.25)
  assert.equal(head.in, 2)
  assert.equal(head.len, 6)
  assert.equal(head.start, 0.25)
  // 素材の先頭より前へは伸びない
  assert.equal(trimClipStart(t, head, -1).in, 0)

  const tail = trimClipEnd(t, c, 0.5)
  assert.equal(tail.len, 4)
  assert.equal(trimClipEnd(t, c, 99).len, 8) // 素材の終端で止まる
  assert.equal(trimClipEnd(t, c, -5).len, 1) // 最低1コマ
})

test('音声クリップは秒単位でトリムできる', () => {
  const t = audioTrack()
  const c = whole(t)
  assert.equal(clipLenSec(t, c), 10)
  const head = trimClipStart(t, c, 2)
  assert.equal(head.in, 2)
  assert.equal(head.len, 8)
  assert.equal(trimClipEnd(t, head, 99).len, 8)
})

test('fps を変えるとクリップの尺だけが変わる(コマ範囲は保たれる)', () => {
  const t8 = cellTrack({ fps: 8 })
  const c = whole(t8)
  assert.equal(clipLenSec(t8, c), 1)
  const t24 = { ...t8, fps: 24 }
  assert.equal(clipLenSec(t24, c), 8 / 24)
  assert.equal(c.in, 0)
  assert.equal(c.len, 8)
})

test('繰り返しで尺いっぱいまで埋める', () => {
  const t = cellTrack()
  const filled = repeatToFill({ ...t, clips: [whole(t)] }, 3)
  assert.equal(filled.clips.length, 3)
  assert.deepEqual(filled.clips.map((c) => c.start), [0, 1, 2])
  assert.equal(trackEndSec(filled), 3)
})

test('貼り付けは相対位置を保ったまま移動する', () => {
  const t = cellTrack()
  const src = [
    { id: 'x', start: 2, in: 0, len: 4 },
    { id: 'y', start: 3, in: 4, len: 4 },
  ]
  const pasted = offsetClipsTo(src, 10)
  assert.deepEqual(pasted.map((c) => c.start), [10, 11])
  assert.notEqual(pasted[0].id, 'x') // id は振り直す
  assert.equal(pasted[1].in, 4)
})

test('プロジェクトの尺は全レイヤーの最大', () => {
  const t = cellTrack({ clips: [{ id: 'c', start: 4, in: 0, len: 8 }] })
  assert.equal(projectDurationSec([t]), 5)
  const bg = bgTrack({ clips: [{ id: 'b', start: 0, in: 0, len: 12 }] })
  assert.equal(projectDurationSec([t, bg]), 12)
  assert.equal(projectDurationSec([]), 0)
})

test('静止画の背景は尺を持たないので好きなだけ伸ばせる', () => {
  const t = bgTrack({ clips: [{ id: 'b', start: 0, in: 0, len: 5 }] })
  assert.equal(sourceUnits(t), Infinity)
  assert.equal(trimClipEnd(t, t.clips[0], 60).len, 60)
  assert.equal(bgSourceTime(t, t.clips[0], 3), 0) // 静止画は常に先頭
})

test('背景動画は素材の尺で止まり、クリップの in から再生される', () => {
  const t = bgTrack({
    kind: 'video',
    duration: 10,
    clips: [{ id: 'b', start: 2, in: 3, len: 4 }],
  })
  const c = t.clips[0]
  assert.equal(sourceUnits(t), 10)
  assert.equal(trimClipEnd(t, c, 99).len, 7) // 素材の残り(10 - 3)まで
  assert.equal(bgSourceTime(t, c, 2), 3)
  assert.equal(bgSourceTime(t, c, 4.5), 5.5)
  assert.equal(activeClip(t, 1.9), null)
  assert.equal(activeClip(t, 3), c)
})

test('重なり順: 配列の後ろにあるレイヤーほど手前に描かれる', () => {
  const drawn = []
  const ctx = {
    setTransform() {},
    clearRect() {},
    fillRect() {},
    drawImage(src) {
      drawn.push(src)
    },
  }
  const book = bgTrack({ id: 'book', el: 'BOOK', clips: [{ id: 'b', start: 0, in: 0, len: 5 }] })
  const cell = cellTrack({ frames: ['cel0'], clips: [{ id: 'c', start: 0, in: 0, len: 1 }] })
  const view = { width: 100, height: 100, bgColor: '#000000', checker: false }

  composite(ctx, { ...view, tracks: [cell, book] }, 0)
  assert.deepEqual(drawn, ['cel0', 'BOOK']) // BOOK がセルの手前

  drawn.length = 0
  composite(ctx, { ...view, tracks: [book, cell] }, 0)
  assert.deepEqual(drawn, ['BOOK', 'cel0']) // 背景として奥に

  drawn.length = 0
  composite(ctx, { ...view, tracks: [{ ...book, visible: false }, cell] }, 0)
  assert.deepEqual(drawn, ['cel0']) // 非表示は描かない

  drawn.length = 0
  composite(ctx, { ...view, tracks: [book, cell] }, 4) // クリップの外
  assert.deepEqual(drawn, ['BOOK'])
})

test('fitRect: contain / cover / fill / none', () => {
  assert.deepEqual(fitRect(100, 100, 200, 100, 'contain'), { x: 50, y: 0, w: 100, h: 100 })
  assert.deepEqual(fitRect(100, 100, 200, 100, 'cover'), { x: 0, y: -50, w: 200, h: 200 })
  assert.deepEqual(fitRect(100, 100, 200, 100, 'fill'), { x: 0, y: 0, w: 200, h: 100 })
  assert.deepEqual(fitRect(100, 100, 200, 100, 'none'), { x: 50, y: 0, w: 100, h: 100 })
})

test('clock: 尺でループし、通知は変化時だけ飛ぶ', () => {
  const c = createClock()
  let hits = 0
  c.subscribe(() => hits++)
  c.setDuration(2)
  c.play()
  c.advance(1.5)
  assert.equal(c.peek().time, 1.5)
  c.advance(1)
  assert.equal(Number(c.peek().time.toFixed(6)), 0.5)

  const before = hits
  c.pause()
  c.pause()
  assert.equal(hits, before + 1)
  assert.equal(c.getSnapshot(), c.getSnapshot())
})

test('clock: ループ off なら終端で止まる', () => {
  const c = createClock()
  c.setDuration(2)
  c.setLoop(false)
  c.play()
  c.advance(5)
  assert.equal(c.peek().time, 2)
  assert.equal(c.peek().playing, false)
})

test('clock: コマ送りはプロジェクト fps 基準', () => {
  const c = createClock()
  c.setDuration(10)
  c.seek(1)
  c.stepFrames(1, 24)
  assert.equal(Number(c.peek().time.toFixed(6)), Number((25 / 24).toFixed(6)))
  c.stepFrames(-2, 24)
  assert.equal(Number(c.peek().time.toFixed(6)), Number((23 / 24).toFixed(6)))
})

test('evenSize: H.264 用に偶数へ切り上げる', async () => {
  const { evenSize, mixSamples } = await import('../src/engine/mixAudio.js')
  assert.equal(evenSize(1920), 1920)
  assert.equal(evenSize(1080), 1080)
  assert.equal(evenSize(1081), 1082)
  assert.equal(evenSize(1), 2)
  assert.equal(evenSize(0), 2)

  const dst = new Float32Array([0, 0, 0, 0, 0, 0])
  const src = new Float32Array([1, 2, 3])
  assert.equal(mixSamples(dst, src, 2, 0, 3, 0.5), 3)
  assert.deepEqual([...dst], [0, 0, 0.5, 1, 1.5, 0])
  assert.equal(mixSamples(dst, src, 5, 0, 3, 1), 1)
})

/* ---------------- 撮影処理 ---------------- */

test('placeRect: 拡大しても中心は動かない。オフセットはそのまま足される', () => {
  const t = cellTrack({ width: 100, height: 100 })
  const a = placeRect(t, 100, 100, 200, 100, 'contain')
  const b = placeRect({ ...t, scale: 2 }, 100, 100, 200, 100)
  assert.deepEqual([a.x + a.w / 2, a.y + a.h / 2], [b.x + b.w / 2, b.y + b.h / 2])
  assert.equal(b.w, 200)
  const c = placeRect({ ...t, x: 10, y: -5 }, 100, 100, 200, 100)
  assert.deepEqual([c.x, c.y], [60, -5])
})

test('trackRectAt: 手前のレイヤーから当たりを探し、非表示は飛ばす', () => {
  const back = bgTrack({ id: 'back' })
  const front = cellTrack({ id: 'front' })
  assert.equal(trackRectAt([back, front], 100, 100, 50, 50).track.id, 'front')
  assert.equal(trackRectAt([back, { ...front, visible: false }], 100, 100, 50, 50).track.id, 'back')
  // 縮めた絵の外側は当たらない
  assert.equal(trackRectAt([{ ...front, scale: 0.1 }], 100, 100, 2, 2), null)
})

test('buildLut: 両端と単調性', () => {
  const lut = buildLut([[0, 0], [1, 1]])
  assert.equal(lut[0], 0)
  assert.equal(lut[255], 255)
  assert.ok(isIdentityLut(lut))

  const s = buildLut([[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]])
  assert.equal(s[0], 0)
  assert.equal(s[255], 255)
  for (let v = 1; v < 256; v++) assert.ok(s[v] >= s[v - 1], `v=${v} で下がった`)
  assert.ok(s[64] < 64) // 暗部は締まる
  assert.ok(s[191] > 191) // 明部は伸びる
})

test('buildLut: 点が足りなければ素通し', () => {
  assert.ok(isIdentityLut(buildLut([])))
  assert.ok(isIdentityLut(buildLut([[0.5, 0.9]])))
})

test('channelLuts: RGB 共通のカーブを通したあとチャンネル別を通す', () => {
  const luts = channelLuts({
    rgb: [[0, 0], [1, 0.5]], // 全体を半分に
    r: [[0, 0], [1, 1]],
    g: [[0, 1], [1, 1]], // G は常に最大
    b: [[0, 0], [1, 1]],
  })
  assert.equal(luts.r[255], 128)
  assert.equal(luts.g[0], 255)
  assert.equal(luts.b[255], 128)
})

test('hasFx: 何も入っていなければ後処理そのものを飛ばす', () => {
  const fx = defaultFx()
  assert.equal(hasFx(fx), false)
  assert.equal(hasFx(undefined), false)
  assert.equal(hasFx({ ...fx, grade: { ...fx.grade, on: true } }), true)
  // 強さ 0 は効かないので数えない
  assert.equal(hasFx({ ...fx, grade: { ...fx.grade, on: true, amount: 0 } }), false)
  // カーブが直線のままなら効かない
  assert.equal(hasFx({ ...fx, curve: { ...fx.curve, on: true } }), false)
  const bent = { ...fx, curve: { ...fx.curve, on: true, rgb: [[0, 0], [0.5, 0.8], [1, 1]] } }
  assert.equal(hasFx(bent), true)
  // 全体スイッチを切れば全部止まる
  assert.equal(hasFx({ ...bent, enabled: false }), false)
})

test('fxKey: 同じ設定なら同じ、変えれば変わる', () => {
  const fx = defaultFx()
  assert.equal(fxKey(fx), '')
  const a = { ...fx, light: { ...fx.light, on: true } }
  assert.equal(fxKey(a), fxKey({ ...fx, light: { ...fx.light, on: true } }))
  assert.notEqual(fxKey(a), fxKey({ ...a, light: { ...a.light, amount: 0.9 } }))
})

test('renderFx: 何も設定されていなければ素材をそのまま返す', () => {
  // document が無い環境なので、素通しの経路だけを確かめる
  assert.equal(renderFx('SRC', 10, 10, defaultFx(), 't1', 0), 'SRC')
})

test('プリセットは書かれていない工程を切る', () => {
  const fx = defaultFx()
  const on = applyPreset(fx, { grade: { color: '#ff0000', amount: 0.5 }, bloom: { amount: 0.3 } })
  assert.equal(on.grade.on, true)
  assert.equal(on.grade.color, '#ff0000')
  assert.equal(on.bloom.on, true)
  assert.equal(on.light.on, false)
  assert.equal(on.blur.on, false)
  assert.equal(on.enabled, true)
  // カーブはプリセットで触らない
  assert.deepEqual(on.curve, fx.curve)
})

test('normalizeFx: 欠けているところを既定値で埋める', () => {
  const fx = normalizeFx({ grade: { on: true } })
  assert.equal(fx.grade.on, true)
  assert.equal(fx.grade.blend, defaultFx().grade.blend)
  assert.equal(fx.light.on, false)
  assert.equal(normalizeFx(null).enabled, true)
})

test('撮影処理を入れたレイヤーも重なり順どおりに描かれる', () => {
  const drawn = []
  const ctx = {
    setTransform() {},
    clearRect() {},
    fillRect() {},
    drawImage(src) {
      drawn.push(src)
    },
  }
  const fx = defaultFx()
  const cell = cellTrack({
    frames: ['cel0'],
    clips: [{ id: 'c', start: 0, in: 0, len: 1 }],
    fx: { ...fx, grade: { ...fx.grade, on: true } },
  })
  composite(ctx, { width: 100, height: 100, bgColor: '#000', checker: false, tracks: [cell] }, 0)
  // document の無い環境では焼かずに素材が出る(合成の順番だけを見る)
  assert.deepEqual(drawn, ['cel0'])
})

/* ---------------- 書き出し先 ---------------- */

test('ファイル名: 使えない文字だけを落とす', () => {
  assert.equal(sanitizeFilename('cut-A_01'), 'cut-A_01')
  assert.equal(sanitizeFilename('a/b:c*d?e"f<g>h|i'), 'abcdefghi')
  assert.equal(sanitizeFilename('  ..hidden  '), 'hidden')
  assert.equal(sanitizeFilename(''), 'PiyopiyoToonz')
  assert.equal(sanitizeFilename('///'), 'PiyopiyoToonz')
})

test('拡張子は重ねない', () => {
  assert.equal(withExtension('cutA', 'mp4'), 'cutA.mp4')
  assert.equal(withExtension('cutA.mp4', 'mp4'), 'cutA.mp4')
  assert.equal(withExtension('cutA.MP4', 'mp4'), 'cutA.MP4')
  assert.equal(withExtension('cutA.mp4', 'webm'), 'cutA.mp4.webm')
})

/* ---------------- シーンの保存と読み込み ---------------- */

const sampleScene = () => {
  const fx = defaultFx()
  const bg = bgTrack({
    name: 'bg.png',
    fileName: 'bg.png',
    clips: [{ id: 'c1', start: 0, in: 0, len: 3 }],
  })
  const cell = cellTrack({
    name: 'cutA',
    files: ['cutA_0001.png', 'cutA_0002.png'],
    frames: new Array(2),
    x: 12,
    y: -8,
    scale: 1.5,
    fx: { ...fx, grade: { ...fx.grade, on: true, color: '#ff8a3d', amount: 0.3 } },
    clips: [{ id: 'c2', start: 1, in: 0, len: 2 }],
  })
  const se = audioTrack({ name: 'tone', fileName: 'tone.wav', clips: [{ id: 'c3', start: 0, in: 0, len: 4 }] })
  return serializeScene({
    tracks: [bg, cell, se],
    stage: { width: 640, height: 360, autoSize: false, bgColor: '#101014', checker: false },
    projectFps: 24,
    muted: false,
    volume: 0.8,
    name: 'cutA',
  })
}

test('シーン: 書き出して読み直すと、重なり順も撮影処理もそのまま', () => {
  const scene = parseScene(sceneToText(sampleScene()))

  assert.deepEqual(scene.tracks.map((t) => t.type), ['bg', 'cell', 'audio'])
  assert.deepEqual(scene.tracks.map((t) => t.files), [
    ['bg.png'],
    ['cutA_0001.png', 'cutA_0002.png'],
    ['tone.wav'],
  ])

  const cell = scene.tracks[1]
  assert.equal(cell.x, 12)
  assert.equal(cell.y, -8)
  assert.equal(cell.scale, 1.5)
  assert.equal(cell.fps, 8)
  assert.equal(cell.fx.grade.on, true)
  assert.equal(cell.fx.grade.color, '#ff8a3d')
  assert.deepEqual(cell.clips, [{ start: 1, in: 0, len: 2 }])

  assert.deepEqual(scene.stage, {
    width: 640,
    height: 360,
    autoSize: false,
    bgColor: '#101014',
    checker: false,
  })
  assert.equal(scene.project.fps, 24)
  assert.equal(scene.project.volume, 0.8)
  assert.equal(scene.project.name, 'cutA')
})

test('シーン: 他のアプリの JSON や壊れた JSON は理由を添えて断る', () => {
  assert.throws(() => parseScene('{'), /JSON/)
  assert.throws(() => parseScene('{"app":"Other","kind":"scene"}'), /PiyopiyoToonz/)
  assert.throws(
    () => parseScene(JSON.stringify({ app: 'PiyopiyoToonz', kind: 'scene', version: 99, tracks: [] })),
    /新しい版/,
  )
  assert.throws(
    () => parseScene(JSON.stringify({ app: 'PiyopiyoToonz', kind: 'scene', version: 1, tracks: [] })),
    /レイヤー/,
  )
})

test('シーン: 素材はファイル名で結び直す(大文字小文字とフォルダは無視)', () => {
  const scene = parseScene(sceneToText(sampleScene()))
  assert.deepEqual(sceneAssetNames(scene), ['bg.png', 'cutA_0001.png', 'cutA_0002.png', 'tone.wav'])

  assert.equal(assetKey('C:\\work\\CutA_0001.PNG'), 'cuta_0001.png')

  const pool = new Map([
    [assetKey('BG.PNG'), 'file'],
    [assetKey('cuts/cutA_0001.png'), 'file'],
  ])
  assert.equal(foundCount(scene.tracks[0], pool), 1)
  assert.equal(foundCount(scene.tracks[1], pool), 1) // 2コマ中1コマだけ見つかった
  assert.equal(foundCount(scene.tracks[2], pool), 0)
})
