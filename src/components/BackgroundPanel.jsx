import { useRef } from 'react'
import { BACKGROUND_ACCEPT } from '../engine/media.js'

const KIND_LABEL = { image: '静止画', video: '動画' }

export default function BackgroundPanel({ background, onPick, onClear, stage, onStage }) {
  const inputRef = useRef(null)

  return (
    <section className="panel">
      <h2 className="panel__title">背景</h2>

      <input
        ref={inputRef}
        type="file"
        accept={BACKGROUND_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
      />

      {background ? (
        <div className="asset">
          <div className="asset__name" title={background.name}>{background.name}</div>
          <div className="asset__meta">
            {KIND_LABEL[background.kind]}
            {background.width > 0 && ` · ${background.width}×${background.height}`}
            {background.duration > 0 && ` · ${background.duration.toFixed(2)}s`}
          </div>
          <div className="row">
            <button onClick={() => inputRef.current.click()}>差し替え</button>
            <button className="danger" onClick={onClear}>外す</button>
          </div>
        </div>
      ) : (
        <button className="wide" onClick={() => inputRef.current.click()}>
          背景を読み込む (png / jpeg / mp4 / webm …)
        </button>
      )}

      <label className="field wide">
        フィット
        <select value={stage.bgFit} onChange={(e) => onStage({ bgFit: e.target.value })}>
          <option value="contain">全体を収める (contain)</option>
          <option value="cover">画面を埋める (cover)</option>
          <option value="fill">引き伸ばす (fill)</option>
          <option value="none">原寸 (none)</option>
        </select>
      </label>

      <h2 className="panel__title">ステージ</h2>

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
    </section>
  )
}
