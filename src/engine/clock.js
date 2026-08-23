/**
 * 再生時間を持つ単一のタイムベース。
 * 背景動画・セル連番はすべてこの時刻(秒)を参照して描画されるため、
 * 素材ごとの fps が違っていても互いに影響しない。
 */
export function createClock() {
  const live = {
    time: 0,
    duration: 0,
    playing: false,
    loop: true,
    rate: 1,
  }
  let snapshot = { ...live }
  const subs = new Set()

  const emit = () => {
    snapshot = { ...live }
    for (const fn of subs) fn()
  }

  const clamp = (t) => {
    if (!Number.isFinite(t) || t < 0) return 0
    if (live.duration > 0 && t > live.duration) return live.duration
    return t
  }

  return {
    /** React 用: 変更があったときだけ新しいオブジェクトを返す */
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    getSnapshot() {
      return snapshot
    },
    /** 描画ループ用: 毎フレーム参照する生の状態(Reactでは使わない) */
    peek() {
      return live
    },

    play() {
      if (live.playing) return
      if (live.duration > 0 && live.time >= live.duration - 1e-6) live.time = 0
      live.playing = true
      emit()
    },
    pause() {
      if (!live.playing) return
      live.playing = false
      emit()
    },
    toggle() {
      live.playing ? this.pause() : this.play()
    },
    stop() {
      live.playing = false
      live.time = 0
      emit()
    },
    seek(t) {
      const next = clamp(t)
      if (next === live.time) return
      live.time = next
      emit()
    },
    /** 描画ループから時間を進める */
    advance(dt) {
      if (!live.playing || dt <= 0) return
      let t = live.time + dt * live.rate
      if (live.duration > 0 && t >= live.duration) {
        if (live.loop) {
          t = t % live.duration
        } else {
          t = live.duration
          live.playing = false
        }
      }
      live.time = t
      emit()
    },
    setDuration(d) {
      const next = Number.isFinite(d) && d > 0 ? d : 0
      if (next === live.duration) return
      live.duration = next
      if (live.time > next) live.time = next
      emit()
    },
    setLoop(v) {
      if (live.loop === v) return
      live.loop = v
      emit()
    },
    setRate(r) {
      if (live.rate === r) return
      live.rate = r
      emit()
    },
    stepFrames(n, fps) {
      const f = Math.round(live.time * fps)
      live.playing = false
      live.time = clamp((f + n) / fps)
      emit()
    },
  }
}
