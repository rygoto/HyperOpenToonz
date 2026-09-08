import { useRef } from 'react'

/**
 * シーン(プロジェクト)の保存と読み込み。
 * JSON には設定だけが入り、絵と音は入らない。読み込むときに同じ素材を選び直す。
 */
export default function ScenePanel({ onSave, onOpen, canSave, simple }) {
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
      {!simple && (
        <p className="hint">
          レイヤーの重なり順・配置・撮影処理・タイムラインを JSON に書き出します。絵と音そのものは入らないので、
          読み込むときに同じ素材を選び直してください（ステージへ JSON をドロップしても開けます）。
        </p>
      )}
    </section>
  )
}
