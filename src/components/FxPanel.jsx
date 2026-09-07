import { FX_PRESETS, applyPreset, canvasFilterSupported, defaultFx, hasFx, normalizeFx } from '../engine/fx.js'
import CurveEditor from './CurveEditor.jsx'

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

function Section({ title, on, onToggle, children, note }) {
  return (
    <div className={'fx-part' + (on ? ' is-on' : '')}>
      <label className="chk fx-part__head">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <strong>{title}</strong>
      </label>
      {on && <div className="fx-part__body">{children}</div>}
      {on && note && <p className="hint">{note}</p>}
    </div>
  )
}

const pct = (v) => Math.round(v * 100) + '%'

/**
 * レイヤー1枚ぶんの撮影処理。
 * 順番は 素材 → ぼかし → トーンカーブ → カラー → 光源 → グロー で固定。
 */
export default function FxPanel({ track, onFx, onBeginEdit }) {
  const fx = normalizeFx(track.fx)
  const filters = canvasFilterSupported()

  /** live=true はドラッグ中の更新(履歴を積まない) */
  const set = (part, patch, live = false) => {
    if (!live) onBeginEdit?.()
    onFx({ ...fx, [part]: { ...fx[part], ...patch } })
  }
  const live = (part, patch) => set(part, patch, true)

  const active = hasFx(fx)

  return (
    <details className="fx">
      <summary className="fx__head">
        <span>撮影処理</span>
        <span className={'fx__badge' + (active ? ' is-on' : '')}>{active ? 'ON' : 'なし'}</span>
      </summary>

      <div className="fx__body">
        <label className="chk">
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              onBeginEdit?.()
              onFx({ ...fx, enabled: e.target.checked })
            }}
          />
          撮影処理を通す（切ると素材そのまま）
        </label>

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

        <Section title="① ぼかし（フォーカス送り / ボケ）" on={fx.blur.on} onToggle={(on) => set('blur', { on })}>
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
          {!filters && <p className="hint">このブラウザは Canvas のぼかしに対応していないため効きません</p>}
        </Section>

        <Section
          title="② トーンカーブ"
          on={fx.curve.on}
          onToggle={(on) => set('curve', { on })}
          note="コントラストや色かぶりの調整。素材の解像度で焼くので書き出しと同じ絵になります。"
        >
          <CurveEditor
            curve={fx.curve}
            onBeginEdit={onBeginEdit}
            onChange={(curve) => onFx({ ...fx, curve })}
          />
        </Section>

        <Section
          title="③ カラー合成（全体に色を被せる）"
          on={fx.grade.on}
          onToggle={(on) => set('grade', { on })}
          note="レイヤーの絵の上に一色を合成します。透明な部分には乗りません。"
        >
          <div className="row">
            <label className="field">
              色
              <input type="color" value={fx.grade.color} onChange={(e) => set('grade', { color: e.target.value })} />
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
        </Section>

        <Section
          title="④ 光源（グラデーションの光 / 影）"
          on={fx.light.on}
          onToggle={(on) => set('light', { on })}
          note="乗算にすればグラデーションの影（パラ）としても使えます。位置はレイヤーの絵に対する割合です。"
        >
          <div className="row">
            <label className="field">
              光の色
              <input type="color" value={fx.light.color} onChange={(e) => set('light', { color: e.target.value })} />
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
        </Section>

        <Section
          title="⑤ グロー（拡散 / ブルーム）"
          on={fx.bloom.on}
          onToggle={(on) => set('bloom', { on })}
          note="明るいところだけをぼかして足し戻します。ハイライトや透過光の柔らかさに。"
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
          {!filters && <p className="hint">このブラウザは Canvas のぼかしに対応していないため効きません</p>}
        </Section>

        {track.type === 'bg' && track.kind === 'video' && (
          <p className="hint">動画は毎コマ焼き直すので、重い設定だとプレビューが遅くなります（書き出しは問題ありません）。</p>
        )}
      </div>
    </details>
  )
}
