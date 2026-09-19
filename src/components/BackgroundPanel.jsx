import { useRef } from 'react'
import { BACKGROUND_ACCEPT, IMAGE_ACCEPT, VIDEO_ACCEPT } from '../engine/media.js'
import Fold from './Fold.jsx'

/** 出力の解像度と下地。どちらのアプリでも同じものを使う */
function StageFold({ stage, onStage }) {
  return (
    <Fold id="stage" title="ステージ" meta={`${stage.width}×${stage.height}`} defaultOpen={false}>
      <div className="row">
        <label className="field">
          幅
          <input
            type="number"
            min="16"
            max="8192"
            value={stage.width}
            disabled={stage.autoSize}
            onChange={(e) => onStage({ width: Math.max(16, Number(e.target.value) || 16) })}
          />
        </label>
        <label className="field">
          高さ
          <input
            type="number"
            min="16"
            max="8192"
            value={stage.height}
            disabled={stage.autoSize}
            onChange={(e) => onStage({ height: Math.max(16, Number(e.target.value) || 16) })}
          />
        </label>
      </div>

      <label className="chk">
        <input
          type="checkbox"
          checked={stage.autoSize}
          onChange={(e) => onStage({ autoSize: e.target.checked })}
        />
        素材に合わせる
      </label>

      <label className="chk">
        <input
          type="checkbox"
          checked={stage.checker}
          onChange={(e) => onStage({ checker: e.target.checked })}
        />
        背景が無いとき市松模様
      </label>

      {!stage.checker && (
        <label className="field wide">
          下地の色
          <input
            type="color"
            value={stage.bgColor}
            onChange={(e) => onStage({ bgColor: e.target.value })}
          />
        </label>
      )}
    </Fold>
  )
}

/**
 * 背景 / BOOK の読み込みとステージ設定。
 * 読み込んだ絵はレイヤー(トラック)になるので、重なり順はトラック側で入れ替える。
 * 音声付加側(sound)では、動画と静止画を並べていくパネルになる。
 */
export default function BackgroundPanel({ onAdd, onAddVideos, stage, onStage, simple, sound = false }) {
  const backInput = useRef(null)
  const bookInput = useRef(null)
  const videoInput = useRef(null)

  const pick = (e, onTop) => {
    const f = e.target.files?.[0]
    if (f) onAdd(f, { onTop })
    e.target.value = ''
  }

  // 音声付加側: 動画と静止画を読み込む(連番は使わない)
  if (sound) {
    return (
      <section className="panel">
        <h2 className="panel__title">動画 / 画像</h2>
        <input
          ref={videoInput}
          type="file"
          accept={`${VIDEO_ACCEPT},${IMAGE_ACCEPT}`}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            if (files.length) onAddVideos(files)
            e.target.value = ''
          }}
        />
        <button className="wide primary" onClick={() => videoInput.current.click()}>
          ＋ 動画 / 画像を読み込む (mp4 / mov / png / jpg …)
        </button>
        {!simple && (
          <p className="hint">
            1つ目は先頭に、2つ目からは今ある動画の後ろへつなげて置きます。静止画は3秒のカットになり、タイムラインで長さを変えられます。分割・移動すれば切り貼りできます。
            動画に入っている音も波形になり、音量を調整できます。
          </p>
        )}
        {!simple && <StageFold stage={stage} onStage={onStage} />}
      </section>
    )
  }

  return (
    <section className="panel">
      <h2 className="panel__title">背景 / BOOK</h2>

      <input
        ref={backInput}
        type="file"
        accept={BACKGROUND_ACCEPT}
        hidden
        onChange={(e) => pick(e, false)}
      />
      <input
        ref={bookInput}
        type="file"
        accept={BACKGROUND_ACCEPT}
        hidden
        onChange={(e) => pick(e, true)}
      />

      <button className="wide" onClick={() => backInput.current.click()}>
        ＋ 背景を読み込む（一番奥へ）
      </button>
      <button className="wide" onClick={() => bookInput.current.click()}>
        ＋ BOOK を読み込む（一番手前へ）
      </button>
      {!simple && (
        <p className="hint">
          png / jpeg / mp4 / webm など。読み込んだ絵はレイヤーになるので、あとからトラックの
          「▲ 奥へ / ▼ 手前へ」でセルの上にも下にも置けます。透過PNGは「ファイル」アプリ経由が確実です。
        </p>
      )}

      {!simple && <StageFold stage={stage} onStage={onStage} />}
    </section>
  )
}
