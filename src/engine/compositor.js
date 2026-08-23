import { cellFrameIndex } from './timeline.js'

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
 * 1フレームぶんの合成。背景 → セルトラック(下から順)に重ねる。
 * 参照するのは各トラック自身の fps だけなので、背景が何 fps でも影響しない。
 */
export function composite(ctx, view, time) {
  const { width: cw, height: ch, background, bgFit, bgColor, tracks, checker } = view

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

  if (background && background.width > 0) {
    const ready = background.kind !== 'video' || background.el.readyState >= 2
    if (ready) {
      const r = fitRect(background.width, background.height, cw, ch, bgFit)
      ctx.drawImage(background.el, r.x, r.y, r.w, r.h)
    }
  }

  for (const track of tracks) {
    if (track.type !== 'cell' || !track.visible) continue
    for (const clip of track.clips) {
      const idx = cellFrameIndex(track, clip, time)
      if (idx == null) continue
      const frame = track.frames[idx]
      if (!frame) continue

      const base = fitRect(track.width, track.height, cw, ch, track.fit)
      const w = base.w * track.scale
      const h = base.h * track.scale
      const x = base.x + (base.w - w) / 2 + track.x
      const y = base.y + (base.h - h) / 2 + track.y

      ctx.globalAlpha = track.opacity
      ctx.globalCompositeOperation = track.blend
      ctx.drawImage(frame, x, y, w, h)
    }
  }

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
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
