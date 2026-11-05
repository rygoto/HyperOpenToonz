import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BACKGROUND_ACCEPT } from '../engine/media.js'
import { MUFFLE_DEFAULT } from '../engine/muffle.js'

function fmt(t) {
  const sign = t < 0 ? '-' : ''
  const a = Math.abs(t)
  const m = Math.floor(a / 60)
  const s = Math.floor(a % 60)
  const ms = Math.floor((a % 1) * 1000)
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 秒の入力。空や負は既定の値に戻す */
function SecInput({ value, onChange, label }) {
  return (
    <label className="fxmenu__sec">
      {label}
      <input
        type="number"
        min="0.05"
        max="30"
        step="0.05"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      秒
    </label>
  )
}

const secOf = (v, fallback) => {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? Math.min(30, Math.round(x * 100) / 100) : fallback
}

/** 「部屋の外」の出発点(こもり具合 / 響き。どれも 0〜1) */
const MUFFLE_PRESETS = [
  { label: '隣の部屋', title: '少しこもって、部屋の響きが乗る', muffle: 0.45, room: 0.3 },
  { label: 'ドア越し', title: 'はっきりこもる。いちばん普通の「部屋の外」', ...MUFFLE_DEFAULT },
  { label: '壁越し(遠い)', title: '分厚い壁の向こう。言葉はほとんど聞き取れない', muffle: 0.85, room: 0.35 },
]

/**
 * エフェクトのメニュー。選んでいるクリップに掛ける
 *   映像 … オーバーラップ(ディゾルブ)。前後に並んだ動画 / 画像のクリップを2つ選ぶ
 *   音声 … フェードイン / フェードアウト。音声のクリップ(何個でも)
 */
function EffectsMenu({ info, onDissolve, onClearDissolve, onFade }) {
  const [open, setOpen] = useState(false)
  const [dis, setDis] = useState('1')
  const [fin, setFin] = useState('1')
  const [fout, setFout] = useState('1')
  const root = useRef(null)
  const panel = useRef(null)

  // 画面の端からはみ出さないよう、横にずらす
  useLayoutEffect(() => {
    const el = panel.current
    if (!open || !el) return
    el.style.transform = ''
    const r = el.getBoundingClientRect()
    const gutter = 16
    let dx = 0
    if (r.right > window.innerWidth - gutter) dx = window.innerWidth - gutter - r.right
    if (r.left + dx < gutter) dx = gutter - r.left
    if (dx) el.style.transform = `translateX(${dx}px)`
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false)
    }
    const esc = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const fades = info.fadeCount > 0
  return (
    <span className="fxmenu" ref={root}>
      <button
        type="button"
        className={open ? 'primary' : ''}
        aria-expanded={open}
        title="選んだクリップにエフェクトを掛ける(映像のオーバーラップ / 音のフェード)"
        onClick={() => {
          // 開くときに、選んでいるクリップに掛かっている長さを入れておく
          if (!open) {
            if (info.dissolve > 0) setDis(String(info.dissolve))
            if (info.fadeIn > 0) setFin(String(info.fadeIn))
            if (info.fadeOut > 0) setFout(String(info.fadeOut))
          }
          setOpen(!open)
        }}
      >
        エフェクト ▾
      </button>
      {open && (
        <div ref={panel} className="fxmenu__panel" role="dialog" aria-label="エフェクト">
          <section className="fxmenu__group">
            <h4>映像: オーバーラップ(ディゾルブ)</h4>
            <p className="fxmenu__hint">
              {info.canDissolve
                ? '2つのクリップが重なっている区間で溶けるように替わります。接しているだけなら、切れ目を真ん中に前後を延ばして「長さ」ぶん重ねます(重なっていればその重なりを使います)'
                : '前後に並んだ動画 / 画像のクリップを2つ選んでください(Shift / Ctrl を押しながらクリック)'}
            </p>
            <div className="fxmenu__row">
              <SecInput label="長さ" value={dis} onChange={setDis} />
              <button
                type="button"
                className="primary"
                disabled={!info.canDissolve}
                onClick={() => {
                  onDissolve(secOf(dis, 1))
                  setOpen(false)
                }}
              >
                {info.dissolved > 0 ? '掛け直す' : '掛ける'}
              </button>
              <button type="button" disabled={!(info.dissolved > 0)} onClick={onClearDissolve}>
                外す
              </button>
            </div>
          </section>
          <section className="fxmenu__group">
            <h4>音声: フェード</h4>
            {!fades && <p className="fxmenu__hint">音声のクリップを選んでください</p>}
            <div className="fxmenu__row">
              <SecInput label="フェードイン" value={fin} onChange={setFin} />
              <button type="button" className="primary" disabled={!fades} onClick={() => onFade({ fadeIn: secOf(fin, 1) })}>
                {info.fadeIn > 0 ? '変更' : '掛ける'}
              </button>
              <button type="button" disabled={!(fades && info.fadeIn > 0)} onClick={() => onFade({ fadeIn: 0 })}>
                外す
              </button>
            </div>
            <div className="fxmenu__row">
              <SecInput label="フェードアウト" value={fout} onChange={setFout} />
              <button type="button" className="primary" disabled={!fades} onClick={() => onFade({ fadeOut: secOf(fout, 1) })}>
                {info.fadeOut > 0 ? '変更' : '掛ける'}
              </button>
              <button type="button" disabled={!(fades && info.fadeOut > 0)} onClick={() => onFade({ fadeOut: 0 })}>
                外す
              </button>
            </div>
          </section>
          <section className="fxmenu__group">
            <h4>音声: 部屋の外</h4>
            <p className="fxmenu__hint">
              {fades
                ? '壁やドアの向こうから聞こえるような、こもった声にします。細かい具合は左のパネルで'
                : '音声のクリップを選んでください'}
            </p>
            <div className="fxmenu__row">
              {MUFFLE_PRESETS.map((p) => (
                <button key={p.label} type="button" className="primary" disabled={!fades} title={p.title} onClick={() => onFade({ muffle: p.muffle, room: p.room })}>
                  {p.label}
                </button>
              ))}
              <button type="button" disabled={!(fades && info.muffled > 0)} onClick={() => onFade({ muffle: 0, room: 0 })}>
                外す
              </button>
            </div>
          </section>
        </div>
      )}
    </span>
  )
}

export default function Transport({
  clock,
  projectFps,
  onProjectFps,
  muted,
  onMuted,
  volume,
  onVolume,
  selectionCount,
  onSplit,
  onDelete,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  canReplace,
  onReplace,
  canDetach,
  onDetach,
  canAnimate,
  onAnimate,
  effects,
  onDissolve,
  onClearDissolve,
  onFade,
  onUndo,
  onRedo,
  sheetOpen,
  onSheet,
  simple,
}) {
  const st = useSyncExternalStore(clock.subscribe, clock.getSnapshot)
  const hasSel = selectionCount > 0
  const replaceInput = useRef(null)

  return (
    <div className="transport">
      <div className="transport__buttons">
        <button type="button" title="先頭へ (Home)" onClick={() => clock.stop()}>⏮</button>
        <button type="button" title="1コマ戻る (←)" onClick={() => clock.stepFrames(-1, projectFps)}>◀︎</button>
        <button
          type="button"
          className="transport__play"
          title="再生 / 一時停止 (Space)"
          onClick={() => clock.toggle()}
        >
          {st.playing ? '❙❙' : '▶'}
        </button>
        <button type="button" title="1コマ進む (→)" onClick={() => clock.stepFrames(1, projectFps)}>▶︎</button>
      </div>

      <div className="transport__time">
        <span className="mono">{fmt(st.time)}</span>
        <span className="transport__sep">/</span>
        <span className="mono dim">{fmt(st.duration)}</span>
        <span className="transport__frame mono dim">
          f{String(Math.round(st.time * projectFps)).padStart(4, '0')}
        </span>
      </div>

      <div className="transport__buttons transport__edit">
        <button type="button" title="再生ヘッドで分割 (Ctrl+B)" onClick={onSplit}>✂ 分割</button>
        <button type="button" title="選択クリップを削除 (Del)" disabled={!hasSel} onClick={onDelete}>
          削除{selectionCount > 1 ? ` (${selectionCount})` : ''}
        </button>
        <button type="button" title="コピー (Ctrl+C)" disabled={!hasSel} onClick={onCopy}>コピー</button>
        <button type="button" title="切り取り (Ctrl+X)" disabled={!hasSel} onClick={onCut}>切り取り</button>
        <button type="button" title="貼り付け (Ctrl+V)" onClick={onPaste}>貼付</button>
        <button type="button" title="複製 (Ctrl+D)" disabled={!hasSel} onClick={onDuplicate}>複製</button>
        <input
          ref={replaceInput}
          type="file"
          accept={BACKGROUND_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onReplace(f)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          title="選択した動画 / 画像のクリップを別の素材に差し替える(位置と長さはそのまま)"
          disabled={!canReplace}
          onClick={() => replaceInput.current.click()}
        >
          差し替え
        </button>
        <button
          type="button"
          title="選んだ動画クリップの音声を、別の音声トラックに分ける(動画のほうは消音されます)"
          disabled={!canDetach}
          onClick={onDetach}
        >
          音声を分離
        </button>
        {onAnimate && (
          <button
            type="button"
            title="選んだ動画 / 画像のクリップ1つの中身を、アニメーション側で作る(このクリップと、尺が被っている音声が参考として渡ります)"
            disabled={!canAnimate}
            onClick={onAnimate}
          >
            アニメーションで作る
          </button>
        )}
        {effects && (
          <EffectsMenu info={effects} onDissolve={onDissolve} onClearDissolve={onClearDissolve} onFade={onFade} />
        )}
        <button type="button" title="元に戻す (Ctrl+Z)" onClick={onUndo}>↺</button>
        <button type="button" title="やり直す (Ctrl+Shift+Z)" onClick={onRedo}>↻</button>
        {onSheet && (
          <button
            type="button"
            className={sheetOpen ? 'primary' : ''}
            aria-pressed={sheetOpen}
            title="透過PNG連番を、何コマ目にどのセルを出すか編集する"
            onClick={onSheet}
          >
            タイムシート編集
          </button>
        )}
      </div>

      <label className="chk">
        <input type="checkbox" checked={st.loop} onChange={(e) => clock.setLoop(e.target.checked)} />
        ループ
      </label>

      {!simple && (
        <>
          <label className="field">
            速度
            <select value={st.rate} onChange={(e) => clock.setRate(Number(e.target.value))}>
              {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            プロジェクトfps
            <input
              type="number"
              min="1"
              max="120"
              step="1"
              value={projectFps}
              onChange={(e) => onProjectFps(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
        </>
      )}

      <div className="transport__audio">
        <button
          className={muted ? 'is-off' : ''}
          title="ミュート"
          onClick={() => onMuted(!muted)}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      </div>
    </div>
  )
}
