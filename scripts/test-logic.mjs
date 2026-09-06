/**
 * 合成・編集に関わる純粋ロジックの確認。
 *   node --test scripts/test-logic.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { composite, fitRect } from '../src/engine/compositor.js'
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
