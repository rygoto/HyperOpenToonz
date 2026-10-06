/**
 * 書き出す前に、ファイル名と出力 fps を決めてもらう。
 * 保存先はサイドバーの「保存先」パネルで決める(ここでは今の保存先を見せるだけ)。
 *
 * formats を渡すと、書き出す形式(MP4 / PNG 連番)も選べる。
 * PNG のときは、頭から何枚書き出すか(frames。null は全部)も決める。
 */
const FPS_PRESETS = [12, 15, 24, 25, 30, 50, 60]

export default function ExportDialog({
  filename,
  onFilename,
  fps,
  onFps,
  formats = null,
  format = 'mp4',
  onFormat,
  frames = null,
  onFrames,
  target,
  meta,
  onStart,
  onClose,
}) {
  const png = format === 'png'
  const count = Math.min(meta.totalFrames, frames ?? meta.totalFrames)
  const ext = png ? (count === 1 ? 'png' : '') : meta.ext

  return (
    <div className="overlay">
      <div className="overlay__box overlay__box--wide">
        <h3 className="dialog__title">{png ? 'PNG 書き出し' : 'MP4 書き出し'}</h3>

        {formats && (
          <div className="presets dialog__row dialog__row--line">
            {formats.map((f) => (
              <button key={f.id} className={format === f.id ? 'is-active' : ''} onClick={() => onFormat(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        )}

        <label className="field wide dialog__row">
          {png && count > 1 ? '名前' : 'ファイル名'}
          <span className="field__input">
            <input
              type="text"
              value={filename}
              placeholder="PiyopiyoToonz"
              onChange={(e) => onFilename(e.target.value)}
            />
            <em>{ext ? '.' + ext : ''}</em>
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

        {png && (
          <div className="dialog__row">
            <label className="field">
              書き出す枚数(頭から)
              <span className="field__input">
                <input
                  type="number"
                  min="1"
                  max={meta.totalFrames}
                  step="1"
                  value={count}
                  onChange={(e) => {
                    const v = Math.round(Number(e.target.value))
                    if (!Number.isFinite(v) || v < 1) return
                    onFrames(v >= meta.totalFrames ? null : v)
                  }}
                />
                <em>/ {meta.totalFrames} 枚</em>
                <span className="presets">
                  <button className={frames == null ? 'is-active' : ''} onClick={() => onFrames(null)}>
                    全部
                  </button>
                </span>
              </span>
            </label>
            <p className="hint">
              {count === 1
                ? '1枚だけなので、PNG 1つをそのまま保存します。'
                : '保存先フォルダがあればその中に「名前」のフォルダを作って 名前_0001.png… と並べ、無ければ ZIP 1つにまとめます。'}
            </p>
          </div>
        )}

        <p className="hint dialog__meta mono">
          {meta.width}×{meta.height} / {fps}fps /{' '}
          {png ? `${count}枚(${(count / fps).toFixed(2)}秒ぶん)` : `${meta.duration.toFixed(2)}秒`}
          {!png && meta.muted ? ' / 音声なし' : ''}
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
