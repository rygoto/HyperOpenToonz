import { activeClip, cellFrameIndex } from './timeline.js'
import { hasFx, pruneFxCache, renderFx } from './fx.js'

/** src を dst の矩形にどう収めるか */
export function fitRect(sw, sh, dw, dh, mode) {
  if (!sw || !sh) return { x: 0, y: 0, w: dw, h: dh }
  if (mode === 'fill') return { x: 0, y: 0, w: dw, h: dh }
  if (mode === 'none') {
    return { x: (dw - sw) / 2, y: (dh - sh) / 2, w: sw, h: sh }
  }
  const s = mode === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh)
  const w = sw * s
  const h = sh * s
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h }
}

/**
 * トラックの fit / 拡大率 / オフセットを当てはめた描画先。
 * 拡大は矩形の中心を軸にするので、拡大率を変えても中心は動かない。
 */
export function placeRect(track, sw, sh, cw, ch) {
  const base = fitRect(sw, sh, cw, ch, track.fit)
  const w = base.w * track.scale
  const h = base.h * track.scale
  return {
    x: base.x + (base.w - w) / 2 + track.x,
    y: base.y + (base.h - h) / 2 + track.y,
    w,
    h,
  }
}

/** ステージ上のこの位置に乗っているレイヤーの描画先(手前から探す) */
export function trackRectAt(tracks, cw, ch, px, py) {
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i]
    if (!t.visible || !(t.width > 0)) continue
    if (t.type !== 'cell' && t.type !== 'bg') continue
    const r = placeRect(t, t.width, t.height, cw, ch)
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return { track: t, rect: r }
  }
  return null
}

/**
 * 1フレームぶんの合成。トラックは配列の順に重ねる(後ろにあるものほど手前)。
 * 背景(bg)もセル(cell)も同じレイヤーとして扱うので、
 * 背景をセルより手前に置けば BOOK になる。
 * 参照するのは各トラック自身の fps だけなので、背景が何 fps でも影響しない。
 */
export function composite(ctx, view, time) {
  const { width: cw, height: ch, bgColor, tracks, checker } = view

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, cw, ch)

  if (checker) {
    drawChecker(ctx, cw, ch)
  } else {
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, cw, ch)
  }

  for (const track of tracks) {
    if (!track.visible) continue
    if (track.type === 'bg') drawBg(ctx, track, cw, ch, time)
    else if (track.type === 'cell') drawCell(ctx, track, cw, ch, time)
  }

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  pruneFxCache(new Set(tracks.map((t) => t.id)))
}

/** 撮影処理を焼いた画を返す。何も設定されていなければ素材そのまま */
function shot(track, source, frameKey) {
  if (!hasFx(track.fx)) return source
  return renderFx(source, track.width, track.height, track.fx, track.id, frameKey)
}

function drawBg(ctx, track, cw, ch, time) {
  if (!(track.width > 0)) return
  if (track.kind === 'video' && track.el.readyState < 2) return
  if (!activeClip(track, time)) return

  // 動画は毎フレーム絵が変わるのでキャッシュしない
  const src = shot(track, track.el, track.kind === 'video' ? null : 'still')
  const r = placeRect(track, track.width, track.height, cw, ch)
  ctx.globalAlpha = track.opacity
  ctx.globalCompositeOperation = track.blend
  ctx.drawImage(src, r.x, r.y, r.w, r.h)
}

function drawCell(ctx, track, cw, ch, time) {
  for (const clip of track.clips) {
    const idx = cellFrameIndex(track, clip, time)
    if (idx == null) continue
    const frame = track.frames[idx]
    if (!frame) continue

    const src = shot(track, frame, idx)
    const r = placeRect(track, track.width, track.height, cw, ch)
    ctx.globalAlpha = track.opacity
    ctx.globalCompositeOperation = track.blend
    ctx.drawImage(src, r.x, r.y, r.w, r.h)
  }
}

function drawChecker(ctx, w, h) {
  const size = Math.max(8, Math.round(Math.min(w, h) / 40))
  ctx.fillStyle = '#3a3a3f'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#4a4a51'
  for (let y = 0; y < h; y += size) {
    for (let x = ((y / size) % 2) * size; x < w; x += size * 2) {
      ctx.fillRect(x, y, size, size)
    }
  }
}
