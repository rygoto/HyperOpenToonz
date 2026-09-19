import { useRef } from 'react'

/**
 * シーン(プロジェクト)の保存と読み込み。
 *   .piyo … 設定と素材の実物をまとめた1ファイル。それだけで元どおりに開ける
 *   JSON  … 設定と素材の名前・パスだけ。絵と音そのものは入らない。
 *           素材フォルダを覚えさせておけば、読み込むときに自動で結び直せる。
 */
export default function ScenePanel({
  onSave,
  onSaveBundle,
  onOpen,
  canSave,
  simple,
  sound = false,
  folders = [],
  canRemember,
  onRememberFolder,
  onForgetFolder,
}) {
  const input = useRef(null)

  return (
    <section className="panel">
      <h2 className="panel__title">シーン</h2>

      <input
        ref={input}
        type="file"
        accept=".piyo,.json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onOpen(f)
          e.target.value = ''
        }}
      />

      <button className="wide primary" disabled={!canSave} onClick={onSaveBundle}>
        📦 素材ごと保存（.piyo）
      </button>
      <button className="wide" disabled={!canSave} onClick={onSave}>
        💾 設定だけ保存（JSON）
      </button>
      <button className="wide" onClick={() => input.current.click()}>
        📂 シーンを開く（.piyo / JSON）
      </button>

      {canRemember && (
        <>
          <button className="wide" onClick={onRememberFolder}>
            📁 素材フォルダを覚える
          </button>
          {folders.length > 0 && (
            <div className="folders">
              {folders.map((f) => (
                <div key={f.id} className={'folders__row' + (f.granted ? ' is-ok' : '')}>
                  <span className="folders__name" title={f.name}>
                    📁 {f.name}
                  </span>
                  <button
                    className="folders__drop"
                    title="このフォルダを忘れる"
                    onClick={() => onForgetFolder(f.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!simple && (
        <p className="hint">
          .piyo には読み込んだ{sound ? '動画・画像・音声' : '絵・動画・音声'}もまるごと入るので、素材を動かしても、別の端末でもそのまま開けます(そのぶん大きくなります)。
          JSON のほうは軽いかわりに、{sound
            ? 'トラック・音量・タイムラインと素材のファイル名 / パスだけで、映像と音そのものは入りません。'
            : 'レイヤーの重なり順・配置・撮影処理・タイムラインと素材のファイル名 / パスだけで、絵と音そのものは入りません。'}
          {canRemember
            ? '素材フォルダを覚えさせておくと、次に JSON を開いたとき同じ場所の素材を自動で見つけて、そのまま復元します。'
            : 'この端末ではフォルダを覚えられないので、読み込むときに素材を選び直してください。'}
        </p>
      )}
    </section>
  )
}
