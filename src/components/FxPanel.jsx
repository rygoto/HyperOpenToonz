import { FX_PRESETS, applyPreset, canvasFilterSupported, defaultFx, hasFx, normalizeFx } from '../engine/fx.js'
import CurveEditor from './CurveEditor.jsx'
import Fold from './Fold.jsx'

const GRADE_LABEL = [
  ['screen', 'スクリーン(明るく被せる)'],
  ['multiply', '乗算(暗く沈める)'],
  ['overlay', 'オーバーレイ'],
  ['soft-light', 'ソフトライト'],
  ['lighter', '加算'],
  ['color', '色だけ置き換え'],
]

const LIGHT_LABEL = [
  ['screen', 'スクリーン(光)'],
  ['lighter', '加算(強い光)'],
  ['overlay', 'オーバーレイ'],
  ['soft-light', 'ソフトライト'],
  ['multiply', '乗算(影として使う)'],
]

/** ドラッグ中は履歴を積まず、つかんだ瞬間に1回だけ積む */
function Slider({ label, value, min, max, step, format, onLive, onBeginEdit }) {
  return (
    <label className="field wide">
      {label} <span className="mono dim">{format ? format(value) : value}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onBeginEdit}
        onKeyDown={onBeginEdit}
        onChange={(e) => onLive(Number(e.target.value))}
      />
    </label>
  )
}

const pct = (v) => Math.round(v * 100) + '%'

/**
 * レイヤー1枚ぶんの撮影処理。
 * 順番は 素材 → ぼかし → トーンカーブ → カラー → 光源 → グロー で固定。
 *
 * 各工程は「入切」と「畳む / 開く」が別。切ったまま中身を用意しておけるし、
 * 効かせたまま畳んで場所を空けられる。シンプル表示ではプリセットだけ出す。
 */
export default function FxPanel({ track, simple, onFx, onBeginEdit }) {
  const fx = normalizeFx(track.fx)
  const filters = canvasFilterSupported()

  /** live=true はドラッグ中の更新(履歴を積まない) */
  const set = (part, patch, live = false) => {
    if (!live) onBeginEdit?.()
    onFx({ ...fx, [part]: { ...fx[part], ...patch } })
  }
  const live = (part, patch) => set(part, patch, true)

  const active = hasFx(fx)
  const noFilterHint = !filters && (
    <p className="hint">このブラウザは Canvas のぼかしに対応していないため効きません</p>
  )

  return (
    <Fold
      id="fx"
      title="🎬 撮影処理"
      meta={active ? 'ON' : 'なし'}
      defaultOpen={false}
      toggle={{
        on: fx.enabled,
        onChange: (on) => {
          onBeginEdit?.()
          onFx({ ...fx, enabled: on })
        },
      }}
    >
      <div className="presets">
        {FX_PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => {
              onBeginEdit?.()
              onFx(applyPreset(fx, p))
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <button
        className="wide danger"
        onClick={() => {
          onBeginEdit?.()
          onFx(defaultFx())
        }}
      >
        撮影処理を全部切る
      </button>

      {simple ? (
        <p className="hint">
          細かい調整（トーンカーブ・カラー・光源・グロー）は、上の「くわしく」に切り替えると出てきます。
        </p>
      ) : (
        <>
          <Fold
            id="fx-blur"
            title="① ぼかし"
            meta="ボケ / フォーカス送り"
            defaultOpen={false}
            toggle={{ on: fx.blur.on, onChange: (on) => set('blur', { on }) }}
          >
            <Slider
              label="ぼかし量"
              value={fx.blur.radius}
              min={0}
              max={60}
              step={0.5}
              format={(v) => v + 'px'}
              onBeginEdit={onBeginEdit}
              onLive={(radius) => live('blur', { radius })}
            />
            {noFilterHint}
          </Fold>

          <Fold
            id="fx-curve"
            title="② トーンカーブ"
            meta="コントラスト / 色かぶり"
            defaultOpen={false}
            toggle={{ on: fx.curve.on, onChange: (on) => set('curve', { on }) }}
          >
            <CurveEditor curve={fx.curve} onBeginEdit={onBeginEdit} onChange={(curve) => onFx({ ...fx, curve })} />
          </Fold>

          <Fold
            id="fx-grade"
            title="③ カラー合成"
            meta="全体に色を被せる"
            defaultOpen={false}
            toggle={{ on: fx.grade.on, onChange: (on) => set('grade', { on }) }}
          >
            <div className="row">
              <label className="field">
                色
                <input
                  type="color"
                  value={fx.grade.color}
                  onChange={(e) => set('grade', { color: e.target.value })}
                />
              </label>
              <label className="field">
                合成
                <select value={fx.grade.blend} onChange={(e) => set('grade', { blend: e.target.value })}>
                  {GRADE_LABEL.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Slider
              label="強さ"
              value={fx.grade.amount}
              min={0}
              max={1}
              step={0.01}
              format={pct}
              onBeginEdit={onBeginEdit}
              onLive={(amount) => live('grade', { amount })}
            />
            <p className="hint">絵の上に一色を合成します。透明な部分には乗りません。</p>
          </Fold>

          <Fold
            id="fx-light"
            title="④ 光源"
            meta="グラデーションの光 / 影"
            defaultOpen={false}
            toggle={{ on: fx.light.on, onChange: (on) => set('light', { on }) }}
          >
            <div className="row">
              <label className="field">
                光の色
                <input
                  type="color"
                  value={fx.light.color}
                  onChange={(e) => set('light', { color: e.target.value })}
                />
              </label>
              <label className="field">
                合成
                <select value={fx.light.blend} onChange={(e) => set('light', { blend: e.target.value })}>
                  {LIGHT_LABEL.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="presets">
              <button
                className={fx.light.shape === 'radial' ? 'is-active' : ''}
                onClick={() => set('light', { shape: 'radial' })}
              >
                点光源
              </button>
              <button
                className={fx.light.shape === 'linear' ? 'is-active' : ''}
                onClick={() => set('light', { shape: 'linear' })}
              >
                平行光
              </button>
            </div>

            <Slider
              label="強さ"
              value={fx.light.amount}
              min={0}
              max={1}
              step={0.01}
              format={pct}
              onBeginEdit={onBeginEdit}
              onLive={(amount) => live('light', { amount })}
            />

            {fx.light.shape === 'radial' ? (
              <>
                <div className="row">
                  <Slider
                    label="横位置"
                    value={fx.light.x}
                    min={-0.5}
                    max={1.5}
                    step={0.01}
                    format={pct}
                    onBeginEdit={onBeginEdit}
                    onLive={(x) => live('light', { x })}
                  />
                  <Slider
                    label="縦位置"
                    value={fx.light.y}
                    min={-0.5}
                    max={1.5}
                    step={0.01}
                    format={pct}
                    onBeginEdit={onBeginEdit}
                    onLive={(y) => live('light', { y })}
                  />
                </div>
                <Slider
                  label="広さ"
                  value={fx.light.radius}
                  min={0.05}
                  max={2}
                  step={0.01}
                  format={pct}
                  onBeginEdit={onBeginEdit}
                  onLive={(radius) => live('light', { radius })}
                />
              </>
            ) : (
              <>
                <Slider
                  label="向き"
                  value={fx.light.angle}
                  min={0}
                  max={360}
                  step={1}
                  format={(v) => v + '°'}
                  onBeginEdit={onBeginEdit}
                  onLive={(angle) => live('light', { angle })}
                />
                <Slider
                  label="届く範囲"
                  value={fx.light.pos}
                  min={0.02}
                  max={1}
                  step={0.01}
                  format={pct}
                  onBeginEdit={onBeginEdit}
                  onLive={(pos) => live('light', { pos })}
                />
              </>
            )}

            <Slider
              label="ぼけ足"
              value={fx.light.soft}
              min={0}
              max={1}
              step={0.01}
              format={pct}
              onBeginEdit={onBeginEdit}
              onLive={(soft) => live('light', { soft })}
            />
            <p className="hint">乗算にすればグラデーションの影（パラ）にもなります。位置は絵に対する割合です。</p>
          </Fold>

          <Fold
            id="fx-bloom"
            title="⑤ グロー"
            meta="拡散 / ブルーム"
            defaultOpen={false}
            toggle={{ on: fx.bloom.on, onChange: (on) => set('bloom', { on }) }}
          >
            <Slider
              label="しきい値（ここより明るい所が光る）"
              value={fx.bloom.threshold}
              min={0.05}
              max={0.95}
              step={0.01}
              format={pct}
              onBeginEdit={onBeginEdit}
              onLive={(threshold) => live('bloom', { threshold })}
            />
            <Slider
              label="広がり"
              value={fx.bloom.radius}
              min={1}
              max={80}
              step={1}
              format={(v) => v + 'px'}
              onBeginEdit={onBeginEdit}
              onLive={(radius) => live('bloom', { radius })}
            />
            <Slider
              label="強さ"
              value={fx.bloom.amount}
              min={0}
              max={1}
              step={0.01}
              format={pct}
              onBeginEdit={onBeginEdit}
              onLive={(amount) => live('bloom', { amount })}
            />
            <p className="hint">明るいところをぼかして足し戻します。輪郭の外へ滲むので透過光にも。</p>
            {noFilterHint}
          </Fold>

          {track.type === 'bg' && track.kind === 'video' && (
            <p className="hint">動画は毎コマ焼き直すので、重い設定だとプレビューが遅くなります。</p>
          )}
        </>
      )}
    </Fold>
  )
}
