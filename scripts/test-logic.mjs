/**
 * 合成・編集に関わる純粋ロジックの確認。
 *   node --test scripts/test-logic.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { composite, fitRect, placeRect, trackRectAt } from '../src/engine/compositor.js'
import { filePath, markPath } from '../src/engine/media.js'
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
  makePool,
  parseScene,
  pathKey,
  poolCoversScene,
  poolFind,
  sceneAssetNames,
  sceneAssets,
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

  const pool = makePool([{ name: 'BG.PNG' }, { name: 'cutA_0001.png' }])
  assert.equal(foundCount(scene.tracks[0], pool), 1)
  assert.equal(foundCount(scene.tracks[1], pool), 1) // 2コマ中1コマだけ見つかった
  assert.equal(foundCount(scene.tracks[2], pool), 0)
})

/* ---------------- 回転 ---------------- */

/** 回転の当たり判定と描画を見るための、記録だけするコンテキスト */
function recordingCtx(log = []) {
  return {
    log,
    setTransform() {},
    clearRect() {},
    fillRect() {},
    save() {
      log.push(['save'])
    },
    restore() {
      log.push(['restore'])
    },
    translate(x, y) {
      log.push(['translate', x, y])
    },
    rotate(a) {
      log.push(['rotate', a])
    },
    drawImage(src, x, y, w, h) {
      log.push(['draw', src, x, y, w, h])
    },
  }
}

test('回転: 中心を軸に回して描く。0度なら余計なことはしない', () => {
  const cell = cellTrack({
    frames: ['cel0'],
    width: 100,
    height: 100,
    clips: [{ id: 'c', start: 0, in: 0, len: 1 }],
  })
  const view = { width: 200, height: 100, bgColor: '#000', checker: false, tracks: [cell] }

  const flat = recordingCtx()
  composite(flat, view, 0)
  assert.deepEqual(flat.log, [['draw', 'cel0', 50, 0, 100, 100]])

  const turned = recordingCtx()
  composite(turned, { ...view, tracks: [{ ...cell, rotate: 90 }] }, 0)
  assert.deepEqual(turned.log, [
    ['save'],
    ['translate', 100, 50], // 絵の中心
    ['rotate', Math.PI / 2],
    ['draw', 'cel0', -50, -50, 100, 100], // 中心を原点に置いて描く
    ['restore'],
  ])
})

test('回転: 拡大率と位置は回しても変わらない(軸は絵の中心)', () => {
  const a = placeRect(cellTrack({ rotate: 0, scale: 2, x: 10 }), 100, 100, 200, 100)
  const b = placeRect(cellTrack({ rotate: 33, scale: 2, x: 10 }), 100, 100, 200, 100)
  assert.deepEqual(a, b)
})

test('回転: 当たり判定も一緒に回る', () => {
  // 横長の絵を 90 度回すと、縦に長い当たり判定になる
  const wide = cellTrack({ width: 200, height: 40, fit: 'none' })
  const turned = { ...wide, rotate: 90 }
  const above = { x: 100, y: 20 } // 中心から上へ 60px
  const side = { x: 180, y: 80 } // 中心から右へ 80px

  assert.equal(trackRectAt([wide], 200, 160, above.x, above.y), null)
  assert.equal(trackRectAt([turned], 200, 160, above.x, above.y).track.id, 't1')
  assert.equal(trackRectAt([wide], 200, 160, side.x, side.y).track.id, 't1')
  assert.equal(trackRectAt([turned], 200, 160, side.x, side.y), null)
})

test('シーン: 回転も保存して読み直せる', () => {
  const doc = sampleScene()
  doc.tracks[1].rotate = -12.5
  const scene = parseScene(sceneToText(doc))
  assert.equal(scene.tracks[1].rotate, -12.5)
  // 回転を持っていない版1の JSON は 0 度として読む
  assert.equal(parseScene(sceneToText(sampleScene())).tracks[1].rotate, 0)
})

/* ---------------- 素材のパス ---------------- */

/** ファイルのふり(結び直しはファイル名とパスしか見ない) */
const fakeFile = (path) => markPath({ name: path.split('/').pop() }, path)

test('パス: 区切りと大文字小文字を揃えて覚える', () => {
  assert.equal(pathKey(String.raw`.\Cuts\A\0001.PNG`), 'cuts/a/0001.png')
  assert.equal(filePath(fakeFile('/cuts/A/0001.png')), 'cuts/A/0001.png')
  // パスが分からないファイルは名前がそのままパスになる
  assert.equal(filePath({ name: '0001.png' }), '0001.png')
})

test('シーン: 素材のパスも書き出して読み直せる。無ければファイル名で代用する', () => {
  const cell = cellTrack({
    name: 'cutA',
    files: ['0001.png', '0002.png'],
    paths: ['素材/cutA/0001.png', '素材/cutA/0002.png'],
    frames: new Array(2),
    clips: [{ id: 'c1', start: 0, in: 0, len: 2 }],
  })
  const doc = serializeScene({
    tracks: [cell],
    stage: { width: 640, height: 360, autoSize: false, bgColor: '#000', checker: false },
    projectFps: 24,
    muted: false,
    volume: 1,
    name: 'cutA',
    folders: [{ name: '素材' }],
  })
  assert.deepEqual(doc.folders, ['素材'])

  const scene = parseScene(sceneToText(doc))
  assert.deepEqual(scene.tracks[0].paths, ['素材/cutA/0001.png', '素材/cutA/0002.png'])
  assert.deepEqual(sceneAssets(scene), [
    { name: '0001.png', path: '素材/cutA/0001.png' },
    { name: '0002.png', path: '素材/cutA/0002.png' },
  ])

  // 版1(パス無し)の JSON はファイル名をパスとして読む
  const old = JSON.parse(sceneToText(doc))
  old.version = 1
  for (const t of old.tracks) delete t.paths
  assert.deepEqual(parseScene(JSON.stringify(old)).tracks[0].paths, ['0001.png', '0002.png'])
})

test('結び直し: 同じ名前が複数あってもパスで選び分ける', () => {
  const a = fakeFile('素材/cutA/0001.png')
  const b = fakeFile('素材/cutB/0001.png')
  const pool = makePool([a, b])

  assert.equal(poolFind(pool, '0001.png', '素材/cutA/0001.png'), a)
  assert.equal(poolFind(pool, '0001.png', '素材/cutB/0001.png'), b)
  // 中の階層がずれていても、末尾がよく合うほうを選ぶ
  assert.equal(poolFind(pool, '0001.png', 'work/2024/cutB/0001.png'), b)
  // パスが分からなければ名前だけで引く(どちらか一方が返る)
  assert.ok([a, b].includes(poolFind(pool, '0001.png')))
  assert.equal(poolFind(pool, '9999.png', '素材/cutA/9999.png'), null)
})

test('結び直し: 素材が全部そろっているかを見て、揃っていれば訊かずに復元できる', () => {
  const cell = cellTrack({
    files: ['0001.png', '0002.png'],
    paths: ['素材/cutA/0001.png', '素材/cutA/0002.png'],
    frames: new Array(2),
    clips: [{ id: 'c1', start: 0, in: 0, len: 2 }],
  })
  const scene = parseScene(
    sceneToText(
      serializeScene({
        tracks: [cell],
        stage: { width: 640, height: 360, autoSize: true, bgColor: '#000', checker: true },
        projectFps: 24,
        muted: false,
        volume: 1,
        name: '',
      }),
    ),
  )

  const half = makePool([fakeFile('素材/cutA/0001.png')])
  assert.equal(poolCoversScene(scene, half), false)
  assert.equal(foundCount(scene.tracks[0], half), 1)

  const all = makePool([fakeFile('素材/cutA/0001.png'), fakeFile('素材/cutA/0002.png')])
  assert.equal(poolCoversScene(scene, all), true)

  // 別のフォルダに引っ越していても、名前が同じなら見つかる
  const moved = makePool([fakeFile('backup/0001.png'), fakeFile('backup/0002.png')])
  assert.equal(poolCoversScene(scene, moved), true)
})

/* ---------------- 音声付加 ---------------- */

test('音声付加: シーンはどちらのアプリのものかを覚える。mode の無い JSON はアニメーション側', () => {
  const video = bgTrack({
    kind: 'video',
    name: 'take1.mp4',
    fileName: 'take1.mp4',
    duration: 12,
    gain: 1.5,
    clips: [{ id: 'c1', start: 0, in: 2, len: 8 }],
  })
  const bgm = audioTrack({ name: 'bgm', fileName: 'bgm.mp3', role: 'bgm', gain: 0.5, clips: [{ id: 'c2', start: 0, in: 0, len: 8 }] })
  const se = audioTrack({ name: 'pop', fileName: 'pop.wav', role: 'se', clips: [{ id: 'c3', start: 3.25, in: 0, len: 0.4 }] })
  const doc = serializeScene({
    tracks: [video, bgm, se],
    stage: { width: 1920, height: 1080, autoSize: true, bgColor: '#000', checker: true },
    projectFps: 30,
    exportFps: 60,
    muted: false,
    volume: 1,
    name: 'take1',
    mode: 'sound',
  })
  assert.equal(doc.mode, 'sound')

  const scene = parseScene(sceneToText(doc))
  assert.equal(scene.mode, 'sound')
  assert.equal(scene.project.exportFps, 60)
  assert.equal(scene.tracks[0].gain, 1.5)
  assert.deepEqual(scene.tracks[0].clips, [{ start: 0, in: 2, len: 8 }])
  assert.deepEqual(scene.tracks.map((t) => t.role), [undefined, 'bgm', 'se'])
  assert.equal(scene.tracks[1].gain, 0.5)
  assert.equal(scene.tracks[2].clips[0].start, 3.25)

  // 前からある JSON(mode 無し、動画の gain 無し)
  const old = JSON.parse(sceneToText(sampleScene()))
  delete old.mode
  delete old.tracks[0].gain
  const anime = parseScene(JSON.stringify(old))
  assert.equal(anime.mode, 'anime')
  // 出力 fps を持っていない JSON は 24fps で書き出す
  delete old.project.exportFps
  assert.equal(parseScene(JSON.stringify(old)).project.exportFps, 24)
  assert.equal(anime.tracks[0].gain, 1)
  assert.equal(anime.tracks[2].role, undefined)
})

test('音声付加: BGM を繰り返しても動画の尻で切れる', async () => {
  const { trimTrackTo } = await import('../src/engine/timeline.js')
  const bgm = audioTrack({ duration: 4 })
  bgm.clips = [whole(bgm)]
  const filled = trimTrackTo(repeatToFill(bgm, 10), 10)
  assert.deepEqual(
    filled.clips.map((c) => [c.start, c.len]),
    [
      [0, 4],
      [4, 4],
      [8, 2],
    ],
  )
  assert.equal(trackEndSec(filled), 10)
  // 切るものが無ければそのまま返す
  assert.equal(trimTrackTo(filled, 10), filled)
  // 尻より後ろから始まるクリップは落とす
  assert.deepEqual(trimTrackTo(filled, 5).clips.map((c) => [c.start, c.len]), [
    [0, 4],
    [4, 1],
  ])
})

test('音声付加: 音を取り出した動画も Web Audio で鳴らし、音量だけの変更では組み直さない', async () => {
  const { sameSchedule, trackSound } = await import('../src/engine/audio.js')
  const buffer = { duration: 12 }
  const video = bgTrack({ kind: 'video', buffer, gain: 1.5, clips: [{ id: 'c1', start: 0, in: 0, len: 12 }] })
  assert.deepEqual(trackSound(video), { buffer, gain: 1.5 })
  // 取り出していない動画(アニメーション側)は video 要素が鳴らす
  assert.equal(trackSound(bgTrack({ kind: 'video' })), null)
  assert.equal(trackSound({ ...video, muted: true }), null)
  assert.equal(trackSound(cellTrack()), null)

  const se = audioTrack({ buffer: { duration: 1 }, clips: [{ id: 'c2', start: 1, in: 0, len: 1 }] })
  const tracks = [video, se]
  assert.equal(sameSchedule(tracks, [video, { ...se, gain: 0.3 }]), true)
  assert.equal(sameSchedule(tracks, [video, { ...se, muted: true }]), false)
  assert.equal(sameSchedule(tracks, [video, { ...se, clips: [...se.clips] }]), false)
  assert.equal(sameSchedule(tracks, [video]), false)
})

test('素材ごと保存: .piyo にまとめて開き直すと、シーンと素材の中身が元どおりに戻る', async () => {
  const { packBundle, readZip, trackSources, unpackBundle } = await import('../src/engine/bundle.js')
  const { serializeScene } = await import('../src/engine/scene.js')
  const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)
  const video = markPath(new File([bytes(5000, 1)], 'cut01.mp4'), 'work/cut01.mp4')
  const cells = [1, 2].map((i) => markPath(new File([bytes(300, i + 10)], `c_000${i}.png`), `work/セル/c_000${i}.png`))
  // 別のフォルダにある同じ名前のものも取り違えない
  const se = markPath(new File([bytes(700, 3)], 'c_0001.png'), 'other/c_0001.png')
  const tracks = [
    bgTrack({ kind: 'video', name: 'cut01', fileName: 'cut01.mp4', path: 'work/cut01.mp4', sources: [video], fx: undefined, clips: [{ id: 'k', start: 0, in: 1, len: 2 }] }),
    cellTrack({ name: 'c', files: ['c_0001.png', 'c_0002.png'], paths: cells.map(filePath), sources: cells, frames: new Array(2), clips: [] }),
    bgTrack({ name: 'still', fileName: 'c_0001.png', path: 'other/c_0001.png', sources: [se], clips: [] }),
  ]
  const doc = serializeScene({ tracks, stage: {}, projectFps: 24, exportFps: 30, muted: false, volume: 1, name: 'n', folders: [], mode: 'sound' })
  const { assets, missing } = trackSources(tracks)
  assert.deepEqual(missing, [])
  assert.equal(assets.length, 4)

  const blob = await packBundle(doc, assets)
  assert.equal((await readZip(blob)).size, 5)

  const { text, files } = await unpackBundle(new File([blob], 'x.piyo'))
  const scene = parseScene(text)
  assert.equal(scene.mode, 'sound')
  assert.equal(scene.project.exportFps, 30)
  const pool = makePool(files)
  assert.equal(poolCoversScene(scene, pool), true)
  for (const orig of [video, ...cells, se]) {
    const got = poolFind(pool, orig.name, filePath(orig))
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), new Uint8Array(await orig.arrayBuffer()))
  }

  // 実物を持たないレイヤーがあればまとめない
  assert.deepEqual(trackSources([bgTrack({ name: 'x', fileName: 'x.png' })]).missing, ['x'])
})
