/**
 * 動作確認用のサンプル素材を samples/ に書き出す。
 *   samples/bg.png            … 背景の静止画 (1280x720)
 *   samples/cell/cell_0001..  … 透過セル連番 (8枚, 1280x720)
 * 依存を増やさないよう PNG は自前でエンコードしている。
 *   node scripts/make-samples.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const W = 1280
const H = 720
const FRAMES = 8

// --- 最小限の PNG エンコーダ (8bit RGBA) ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const src = y * width * 4
    const dst = y * (width * 4 + 1)
    raw[dst] = 0 // filter: none
    rgba.copy(raw, dst + 1, src, src + width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- 背景: 空のグラデーション + 地平線 + 目印の縦線 ---
function makeBackground() {
  const buf = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    const t = y / H
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const ground = t > 0.72
      const stripe = x % 160 < 2
      buf[i] = ground ? 70 : Math.round(40 + 120 * t)
      buf[i + 1] = ground ? 110 : Math.round(90 + 130 * t)
      buf[i + 2] = ground ? 60 : Math.round(180 + 60 * t)
      if (stripe) {
        buf[i] = 255
        buf[i + 1] = 255
        buf[i + 2] = 255
      }
      buf[i + 3] = 255
    }
  }
  return buf
}

// --- セル: 透過背景に丸が横切る (コマごとに色と位置が変わる) ---
function makeCell(index) {
  const buf = Buffer.alloc(W * H * 4) // 既定で完全透過
  const cx = Math.round((W / (FRAMES + 1)) * (index + 1))
  const cy = Math.round(H / 2 + Math.sin((index / FRAMES) * Math.PI * 2) * 120)
  const r = 90
  const hue = index / FRAMES
  const col = [
    Math.round(200 + 55 * Math.sin(hue * 6.283)),
    Math.round(120 + 80 * Math.sin(hue * 6.283 + 2)),
    Math.round(120 + 80 * Math.sin(hue * 6.283 + 4)),
  ]

  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= H) continue
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= W) continue
      const d = Math.hypot(x - cx, y - cy)
      if (d > r) continue
      const i = (y * W + x) * 4
      buf[i] = col[0]
      buf[i + 1] = col[1]
      buf[i + 2] = col[2]
      buf[i + 3] = Math.round(255 * Math.min(1, r - d)) // 縁だけアンチエイリアス
    }
  }

  // 左上にコマ番号ぶんの四角を並べる(何コマ目か目視で分かるように)
  for (let k = 0; k <= index; k++) {
    for (let y = 30; y < 70; y++) {
      for (let x = 30 + k * 50; x < 70 + k * 50; x++) {
        const i = (y * W + x) * 4
        buf[i] = 255
        buf[i + 1] = 60
        buf[i + 2] = 60
        buf[i + 3] = 255
      }
    }
  }
  return buf
}

// --- 音声: 0.5秒ごとに音が変わる 4秒のモノラル WAV ---
// 切り貼りの結果が耳と波形の両方で分かるように、音程を階段状にしてある。
function makeWav() {
  const rate = 44100
  const seconds = 4
  const n = rate * seconds
  const notes = [440, 494, 554, 587, 659, 587, 554, 494]
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const step = Math.min(notes.length - 1, Math.floor(t * 2))
    const local = t * 2 - step
    const env = Math.exp(-local * 4) * (1 - Math.exp(-local * 200))
    const v = Math.sin(2 * Math.PI * notes[step] * t) * env * 0.6
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16) // fmt チャンクの長さ
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // モノラル
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28) // バイト/秒
  header.writeUInt16LE(2, 32) // ブロックサイズ
  header.writeUInt16LE(16, 34) // ビット深度
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

mkdirSync(join(ROOT, 'samples', 'cell'), { recursive: true })
writeFileSync(join(ROOT, 'samples', 'bg.png'), encodePng(W, H, makeBackground()))
for (let i = 0; i < FRAMES; i++) {
  const name = `cell_${String(i + 1).padStart(4, '0')}.png`
  writeFileSync(join(ROOT, 'samples', 'cell', name), encodePng(W, H, makeCell(i)))
}
writeFileSync(join(ROOT, 'samples', 'tone.wav'), makeWav())
console.log(`samples/bg.png, samples/cell/*.png (${FRAMES}枚), samples/tone.wav を書き出しました`)
