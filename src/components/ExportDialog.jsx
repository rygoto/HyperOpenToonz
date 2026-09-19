/**
 * 書き出す前に、ファイル名と出力 fps を決めてもらう。
 * 保存先はサイドバーの「保存先」パネルで決める(ここでは今の保存先を見せるだけ)。
 */
const FPS_PRESETS = [12, 15, 24, 25, 30, 50, 60]

export default function ExportDialog({
  filename,
  onFilename,
  fps,
  onFps,
  target,
  meta,
  onStart,
  onClose,
}) {
  return (
    <div className="overlay">
      <div className="overlay__box overlay__box--wide">
        <h3 className="dialog__title">MP4 書き出し</h3>

        <label className="field wide dialog__row">
          ファイル名
          <span className="field__input">
            <input
              type="text"
              value={filename}
              placeholder="PiyopiyoToonz"
              onChange={(e) => onFilename(e.target.value)}
            />
            <em>{meta.ext ? '.' + meta.ext : ''}</em>
          </span>
        </label>

        <p className="hint dialog__row">
          保存先: {target}(左の「保存先」で変えられます)
        </p>

        <div className="dialog__row">
          <label className="field">
            出力 fps
            <span className="field__input">
              <input
                type="number"
                min="1"
                max="120"
                step="1"
                value={fps}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value))
                  if (Number.isFinite(v) && v > 0) onFps(Math.min(120, v))
                }}
              />
              <em>fps</em>
            </span>
          </label>
          <div className="presets">
            {FPS_PRESETS.map((f) => (
              <button key={f} className={fps === f ? 'is-active' : ''} onClick={() => onFps(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>

        <p className="hint dialog__meta mono">
          {meta.width}×{meta.height} / {fps}fps / {meta.duration.toFixed(2)}秒
          {meta.muted ? ' / 音声なし' : ''}
        </p>

        <div className="row">
          <button className="primary wide" onClick={onStart}>
            書き出す
          </button>
          <button className="wide" onClick={onClose}>
            やめる
          </button>
        </div>
      </div>
    </div>
  )
}
