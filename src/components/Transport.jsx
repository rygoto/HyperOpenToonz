import { useSyncExternalStore } from 'react'

function fmt(t) {
  const sign = t < 0 ? '-' : ''
  const a = Math.abs(t)
  const m = Math.floor(a / 60)
  const s = Math.floor(a % 60)
  const ms = Math.floor((a % 1) * 1000)
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

export default function Transport({
  clock,
  projectFps,
  onProjectFps,
  muted,
  onMuted,
  volume,
  onVolume,
  selectionCount,
  onSplit,
  onDelete,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  onUndo,
  onRedo,
}) {
  const st = useSyncExternalStore(clock.subscribe, clock.getSnapshot)
  const hasSel = selectionCount > 0

  return (
    <div className="transport">
      <div className="transport__buttons">
        <button type="button" title="先頭へ (Home)" onClick={() => clock.stop()}>⏮</button>
        <button type="button" title="1コマ戻る (←)" onClick={() => clock.stepFrames(-1, projectFps)}>◀︎</button>
        <button
          type="button"
          className="transport__play"
          title="再生 / 一時停止 (Space)"
          onClick={() => clock.toggle()}
        >
          {st.playing ? '❙❙' : '▶'}
        </button>
        <button type="button" title="1コマ進む (→)" onClick={() => clock.stepFrames(1, projectFps)}>▶︎</button>
      </div>

      <div className="transport__time">
        <span className="mono">{fmt(st.time)}</span>
        <span className="transport__sep">/</span>
        <span className="mono dim">{fmt(st.duration)}</span>
        <span className="transport__frame mono dim">
          f{String(Math.round(st.time * projectFps)).padStart(4, '0')}
        </span>
      </div>

      <div className="transport__buttons transport__edit">
        <button type="button" title="再生ヘッドで分割 (Ctrl+B)" onClick={onSplit}>✂ 分割</button>
        <button type="button" title="選択クリップを削除 (Del)" disabled={!hasSel} onClick={onDelete}>
          削除{selectionCount > 1 ? ` (${selectionCount})` : ''}
        </button>
        <button type="button" title="コピー (Ctrl+C)" disabled={!hasSel} onClick={onCopy}>コピー</button>
        <button type="button" title="切り取り (Ctrl+X)" disabled={!hasSel} onClick={onCut}>切り取り</button>
        <button type="button" title="貼り付け (Ctrl+V)" onClick={onPaste}>貼付</button>
        <button type="button" title="複製 (Ctrl+D)" disabled={!hasSel} onClick={onDuplicate}>複製</button>
        <button type="button" title="元に戻す (Ctrl+Z)" onClick={onUndo}>↺</button>
        <button type="button" title="やり直す (Ctrl+Shift+Z)" onClick={onRedo}>↻</button>
      </div>

      <label className="chk">
        <input type="checkbox" checked={st.loop} onChange={(e) => clock.setLoop(e.target.checked)} />
        ループ
      </label>

      <label className="field">
        速度
        <select value={st.rate} onChange={(e) => clock.setRate(Number(e.target.value))}>
          {[0.25, 0.5, 1, 1.5, 2].map((r) => (
            <option key={r} value={r}>{r}x</option>
          ))}
        </select>
      </label>

      <label className="field">
        プロジェクトfps
        <input
          type="number"
          min="1"
          max="120"
          step="1"
          value={projectFps}
          onChange={(e) => onProjectFps(Math.max(1, Number(e.target.value) || 1))}
        />
      </label>

      <div className="transport__audio">
        <button
          className={muted ? 'is-off' : ''}
          title="ミュート"
          onClick={() => onMuted(!muted)}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      </div>
    </div>
  )
}
