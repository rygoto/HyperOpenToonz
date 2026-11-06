import { hasMuffle, insertMuffle } from './muffle.js'
import { hasTube, insertTube } from './tube.js'

/**
 * クリップに掛けた声のエフェクトを、input のあとに順に挟む(部屋の外 → 伝声管)。
 * 何も掛かっていなければ null。プレビューと書き出しで同じ順にするため、ここにまとめてある
 */
export function insertVoiceFx(ctx, input, clip) {
  let last = input
  const nodes = []
  for (const [has, insert] of [
    [hasMuffle, insertMuffle],
    [hasTube, insertTube],
  ]) {
    if (!has(clip)) continue
    const fx = insert(ctx, last, clip)
    nodes.push(...fx.nodes)
    last = fx.out
  }
  return nodes.length > 0 ? { out: last, nodes } : null
}
