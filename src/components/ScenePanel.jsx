import { useRef } from 'react'

/**
 * シーン(プロジェクト)の保存と読み込み。
 * JSON に入るのは設定と素材の名前・パスだけ。絵と音そのものは入らない。
 * 素材フォルダを覚えさせておけば、読み込むときに自動で結び直せる。
 */
export default function ScenePanel({
  onSave,
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
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onOpen(f)
          e.target.value = ''
        }}
      />

      <button className="wide" disabled={!canSave} onClick={onSave}>
        💾 シーンを保存（JSON）
      </button>
      <button className="wide" onClick={() => input.current.click()}>
        📂 シーンを読み込む（JSON）
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
          {sound
            ? '動画と BGM / SE のトラック・音量・タイムラインと、素材のファイル名 / パスを JSON に書き出します。映像と音そのものは入りません。'
            : 'レイヤーの重なり順・配置・撮影処理・タイムラインと、素材のファイル名 / パスを JSON に書き出します。絵と音そのものは入りません。'}
          {canRemember
            ? '素材フォルダを覚えさせておくと、次に JSON を開いたとき同じ場所の素材を自動で見つけて、そのまま復元します。'
            : 'この端末ではフォルダを覚えられないので、読み込むときに素材を選び直してください。'}
        </p>
      )}
    </section>
  )
}
