import { useState } from 'react'
import { canPickDirectory, canPickSaveFile, isIPadLike } from '../engine/saveFile.js'

/**
 * 書き出す前に、ファイル名と保存先を決めてもらう。
 *
 * 保存先の決め方はブラウザによって違う:
 *   フォルダを覚えられる … Chrome / Edge など(File System Access API)
 *   毎回ダイアログ       … showSaveFilePicker があるとき
 *   共有シート           … iPad / iPhone
 *   ダウンロード         … それ以外(ブラウザの既定の場所)
 */
export default function ExportDialog({ filename, onFilename, dir, onPickDir, onForgetDir, askWhere, onAskWhere, meta, onStart, onClose }) {
  const [error, setError] = useState(null)
  const folders = canPickDirectory()
  const picker = canPickSaveFile()

  const pick = async () => {
    setError(null)
    try {
      await onPickDir()
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e?.message || 'フォルダを選べませんでした')
    }
  }

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

        <div className="dialog__row">
          <div className="field">保存先</div>
          {folders ? (
            <>
              <div className="row">
                <button className="wide" onClick={pick}>
                  {dir ? 'フォルダを変える' : 'フォルダを選ぶ'}
                </button>
                {dir && (
                  <button onClick={onForgetDir}>忘れる</button>
                )}
              </div>
              <p className="hint">
                {dir
                  ? `📁 ${dir.name}${dir.granted ? '' : '（書き出すときに許可を聞き直します）'} に保存します。同じ名前があるときは連番になります。`
                  : 'フォルダを選ぶと次回からもそこへ保存します。選ばない場合は下の指定に従います。'}
              </p>
              {!dir && picker && (
                <label className="chk">
                  <input type="checkbox" checked={askWhere} onChange={(e) => onAskWhere(e.target.checked)} />
                  書き出したあとに保存ダイアログで場所を選ぶ
                </label>
              )}
            </>
          ) : (
            <p className="hint">
              {isIPadLike()
                ? 'iPad では書き出し後に共有シートが開きます。「ファイルに保存」から好きなフォルダを選べます。'
                : picker
                  ? '書き出したあとに保存ダイアログが開きます。'
                  : 'このブラウザでは保存先を指定できないため、既定のダウンロード先に保存されます。'}
            </p>
          )}
        </div>

        <p className="hint dialog__meta mono">
          {meta.width}×{meta.height} / {meta.fps}fps / {meta.duration.toFixed(2)}秒
          {meta.muted ? ' / 音声なし' : ''}
        </p>

        {error && <p className="hint dialog__error">{error}</p>}

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
