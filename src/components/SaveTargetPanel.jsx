import { useState } from 'react'
import { canPickDirectory, canPickSaveFile, isIPadLike } from '../engine/saveFile.js'

/**
 * 保存先。MP4 書き出し・素材ごと保存(.piyo)・設定だけ保存(JSON)の全部に効く。
 *
 * 保存先の決め方はブラウザによって違う:
 *   フォルダを覚えられる … Chrome / Edge など(File System Access API)
 *   毎回ダイアログ       … showSaveFilePicker があるとき
 *   共有シート           … iPad / iPhone
 *   ダウンロード         … それ以外(ブラウザの既定の場所)
 *
 * sceneFile … シーンを開いたあとは、そのシーンと同じフォルダに保存する(そのファイル名)。
 *             次に保存するときにフォルダを確かめて、それ以降の保存先として覚える。
 */
export default function SaveTargetPanel({
  dir,
  sceneFile,
  onForgetSceneFile,
  onPickDir,
  onForgetDir,
  askWhere,
  onAskWhere,
  simple,
}) {
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
    <section className="panel">
      <h2 className="panel__title">保存先</h2>

      {folders ? (
        <>
          {sceneFile ? (
            <div className="folders">
              <div className="folders__row is-ok">
                <span className="folders__name" title={sceneFile}>
                  📄 {sceneFile} と同じフォルダ
                </span>
                <button
                  className="folders__drop"
                  title="シーンのフォルダではなく、これまでの保存先を使う"
                  onClick={onForgetSceneFile}
                >
                  ✕
                </button>
              </div>
            </div>
          ) : dir && (
            <div className="folders">
              <div className={'folders__row' + (dir.granted ? ' is-ok' : '')}>
                <span className="folders__name" title={dir.name}>
                  📁 {dir.name}
                </span>
                <button className="folders__drop" title="このフォルダを忘れる" onClick={onForgetDir}>
                  ✕
                </button>
              </div>
            </div>
          )}
          <button className="wide" onClick={pick}>
            {dir ? '📁 保存先フォルダを変える' : '📁 保存先フォルダを選ぶ'}
          </button>
          {!dir && !sceneFile && picker && (
            <label className="chk">
              <input type="checkbox" checked={askWhere} onChange={(e) => onAskWhere(e.target.checked)} />
              保存のたびにダイアログで場所を選ぶ
            </label>
          )}
          {error && <p className="hint dialog__error">{error}</p>}
          {!simple && (
            <p className="hint">
              {sceneFile
                ? `開いたシーン(${sceneFile})と同じフォルダに保存します。最初に保存するとき、そのフォルダでフォルダ選択が開くので「選択」を押してください。以降はそこへそのまま保存します。`
                : dir
                ? `MP4・.piyo・JSON はすべて 📁 ${dir.name} に保存します${dir.granted ? '' : '(保存するときに許可を聞き直します)'}。同じ名前があるときは連番になります。`
                : askWhere
                  ? '保存するたびにダイアログで場所と名前を選びます。'
                  : 'フォルダを選ぶと、次回からもそこへ保存します。選ばなければブラウザのダウンロード先に保存します。'}
            </p>
          )}
        </>
      ) : (
        !simple && (
          <p className="hint">
            {isIPadLike()
              ? 'iPad では保存するときに共有シートが開きます。「ファイルに保存」から好きなフォルダを選べます。'
              : picker
                ? '保存するたびにダイアログが開きます。'
                : 'このブラウザでは保存先を指定できないため、既定のダウンロード先に保存されます。'}
          </p>
        )
      )}
    </section>
  )
}

/** 今の保存先を一言で(書き出しダイアログなどに添える) */
export function saveTargetLabel(dir, askWhere, sceneFile) {
  if (sceneFile && canPickDirectory()) return `📄 ${sceneFile} と同じフォルダ`
  if (dir) return `📁 ${dir.name}`
  if (isIPadLike()) return '共有シート'
  if (askWhere && canPickSaveFile()) return '保存のたびにダイアログで選ぶ'
  return 'ダウンロード先'
}
