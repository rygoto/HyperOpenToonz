/**
 * 合成・編集に関わる純粋ロジックの確認。
 *   node --test scripts/test-logic.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fitRect } from '../src/engine/compositor.js'
import { createClock } from '../src/engine/clock.js'
import {
  cellFrameIndex,
  clipEndSec,
  clipLenSec,
  makeClip,
  offsetClipsTo,
  projectDurationSec,
  repeatToFill,
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

test('プロジェクトの尺は背景と全トラックの最大', () => {
  const t = cellTrack({ clips: [{ id: 'c', start: 4, in: 0, len: 8 }] })
  assert.equal(projectDurationSec([t], null), 5)
  assert.equal(projectDurationSec([t], { duration: 12 }), 12)
  assert.equal(projectDurationSec([], { duration: 3 }), 3)
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
