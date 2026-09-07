import { useRef } from 'react'
import { AUDIO_ACCEPT } from '../engine/media.js'
import { clipLenSec, isVisual, minUnits, sourceUnits, unitsPerSecond } from '../engine/timeline.js'
import FxPanel from './FxPanel.jsx'

const FPS_PRESETS = [4, 6, 8, 12, 15, 24, 30]

const KIND_LABEL = { image: '静止画', video: '動画' }

function NumberField({ label, value, onChange, step = 1, min, max, suffix }) {
  return (
    <label className="field">
      {label}
      <span className="field__input">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  )
}

/** 絵のレイヤー(セル / 背景)に共通の配置・合成 */
function TransformBody({ track, onPatch, onPatchLive, onBeginEdit, grabbed, onGrab }) {
  return (
    <>
      <label className="field wide">
        不透明度 <span className="mono dim">{Math.round(track.opacity * 100)}%</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={track.opacity}
          onPointerDown={onBeginEdit}
          onKeyDown={onBeginEdit}
          onChange={(e) => onPatchLive({ opacity: Number(e.target.value) })}
        />
      </label>

      <button className={'wide' + (grabbed ? ' primary' : '')} onClick={onGrab}>
        {grabbed ? '✥ ステージで操作中' : '✥ ステージで直接動かす'}
      </button>

      <div className="row">
        <NumberField
          label="拡大率"
          value={Number(track.scale.toFixed(3))}
          step={0.05}
          min={0.01}
          onChange={(v) => onPatch({ scale: Math.max(0.01, v) })}
        />
        <NumberField label="X" value={Math.round(track.x)} suffix="px" onChange={(v) => onPatch({ x: v })} />
        <NumberField label="Y" value={Math.round(track.y)} suffix="px" onChange={(v) => onPatch({ y: v })} />
      </div>

      <div className="row">
        <label className="field">
          配置
          <select value={track.fit} onChange={(e) => onPatch({ fit: e.target.value })}>
            <option value="contain">収める</option>
            <option value="cover">埋める</option>
            <option value="fill">引き伸ばす</option>
            <option value="none">原寸</option>
          </select>
        </label>
        <label className="field">
          合成
          <select value={track.blend} onChange={(e) => onPatch({ blend: e.target.value })}>
            <option value="source-over">通常</option>
            <option value="multiply">乗算</option>
            <option value="screen">スクリーン</option>
            <option value="overlay">オーバーレイ</option>
            <option value="lighter">加算</option>
          </select>
        </label>
      </div>
    </>
  )
}

function CellBody({ track, onPatch, onRepeatFill, ...rest }) {
  return (
    <>
      <div className="row">
        <NumberField
          label="セルのfps"
          value={track.fps}
          min={0.1}
          step={1}
          suffix="fps"
          onChange={(v) => onPatch({ fps: Math.max(0.1, v) })}
        />
        <div className="presets">
          {FPS_PRESETS.map((f) => (
            <button
              key={f}
              className={track.fps === f ? 'is-active' : ''}
              onClick={() => onPatch({ fps: f })}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <TransformBody track={track} onPatch={onPatch} {...rest} />

      <button onClick={onRepeatFill}>最後のクリップで尺いっぱいまで繰り返す</button>
    </>
  )
}

function BgBody({ track, onPatch, onRepeatFill, ...rest }) {
  return (
    <>
      <TransformBody track={track} onPatch={onPatch} {...rest} />

      {track.kind === 'video' && (
        <label className="chk">
          <input
            type="checkbox"
            checked={track.muted}
            onChange={(e) => onPatch({ muted: e.target.checked })}
          />
          この動画の音を消す
        </label>
      )}

      <button onClick={onRepeatFill}>最後のクリップで尺いっぱいまで繰り返す</button>
    </>
  )
}

function AudioBody({ track, onPatch }) {
  return (
    <>
      <label className="field wide">
        音量 <span className="mono dim">{Math.round(track.gain * 100)}%</span>
        <input
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={track.gain}
          onChange={(e) => onPatch({ gain: Number(e.target.value) })}
        />
      </label>
      <label className="chk">
        <input type="checkbox" checked={track.muted} onChange={(e) => onPatch({ muted: e.target.checked })} />
        ミュート
      </label>
      <p className="hint">{track.duration.toFixed(2)}秒 / {track.clips.length}クリップ</p>
    </>
  )
}

function trackMeta(track) {
  if (track.type === 'cell') return `${track.frames.length}枚 ${track.fps}fps`
  if (track.type === 'bg') return `${KIND_LABEL[track.kind] ?? '背景'} ${track.width}×${track.height}`
  return '音声'
}

function TrackRow({
  track,
  index,
  total,
  selection,
  onPatch,
  onPatchLive,
  onBeginEdit,
  onClipPatch,
  onRemove,
  onMove,
  onRepeatFill,
  grabbed,
  onGrab,
}) {
  const selected = track.clips.filter((c) => selection.includes(c.id))
  const only = selected.length === 1 ? selected[0] : null
  const visual = isVisual(track)
  const shared = { onPatchLive, onBeginEdit, grabbed, onGrab }

  return (
    <details className={'layer' + (grabbed ? ' is-grabbed' : '')} open={index === 0}>
      <summary className="layer__head">
        <button
          className={'layer__eye' + ((visual ? track.visible : !track.muted) ? '' : ' is-off')}
          title={visual ? '表示 / 非表示' : 'ミュート'}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onPatch(visual ? { visible: !track.visible } : { muted: !track.muted })
          }}
        >
          {visual ? (track.visible ? '◉' : '◯') : track.muted ? '🔇' : '🔊'}
        </button>
        <span className="layer__name" title={track.name}>{track.name}</span>
        <span className="layer__meta mono">{trackMeta(track)}</span>
      </summary>

      <div className="layer__body">
        {track.type === 'cell' && (
          <CellBody track={track} onPatch={onPatch} onRepeatFill={onRepeatFill} {...shared} />
        )}
        {track.type === 'bg' && (
          <BgBody track={track} onPatch={onPatch} onRepeatFill={onRepeatFill} {...shared} />
        )}
        {track.type === 'audio' && <AudioBody track={track} onPatch={onPatch} />}

        {visual && (
          <FxPanel
            track={track}
            onBeginEdit={onBeginEdit}
            onFx={(fx) => onPatchLive({ fx })}
          />
        )}

        {only && (
          <div className="clip-inspector">
            <div className="clip-inspector__title">選択中のクリップ</div>
            <div className="row">
              <NumberField
                label="開始"
                value={Number(only.start.toFixed(3))}
                step={0.1}
                min={0}
                suffix="s"
                onChange={(v) => onClipPatch(track.id, only.id, { start: Math.max(0, v) })}
              />
              <NumberField
                label="長さ"
                value={Number(clipLenSec(track, only).toFixed(3))}
                step={0.1}
                min={0.02}
                suffix="s"
                onChange={(v) =>
                  onClipPatch(track.id, only.id, {
                    len: Math.max(
                      minUnits(track),
                      Math.min(v * unitsPerSecond(track), sourceUnits(track) - only.in),
                    ),
                  })
                }
              />
            </div>
          </div>
        )}

        <div className="row layer__actions">
          <button disabled={index === 0} onClick={() => onMove(-1)}>▲ 奥へ</button>
          <button disabled={index === total - 1} onClick={() => onMove(1)}>▼ 手前へ</button>
          <button className="danger" onClick={onRemove}>削除</button>
        </div>
        {visual && <p className="hint">下にあるレイヤーほど手前に重なります</p>}
      </div>
    </details>
  )
}

export default function TrackPanel({
  tracks,
  selection,
  onAddCells,
  onAddAudio,
  onPatch,
  onPatchLive,
  onBeginEdit,
  onClipPatch,
  onRemove,
  onMove,
  onRepeatFill,
  grabTrackId,
  onGrab,
}) {
  const cellInput = useRef(null)
  const audioInput = useRef(null)

  return (
    <section className="panel">
      <h2 className="panel__title">レイヤー</h2>

      <input
        ref={cellInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onAddCells(files)
          e.target.value = ''
        }}
      />
      <input
        ref={audioInput}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onAddAudio(files)
          e.target.value = ''
        }}
      />

      <button className="wide primary" onClick={() => cellInput.current.click()}>
        ＋ 透過PNG連番を読み込む
      </button>
      <button className="wide" onClick={() => audioInput.current.click()}>
        ＋ 音声ファイルを読み込む (mp3 / wav …)
      </button>
      <p className="hint">連番はファイル名の数値順。PC はフォルダのドロップ、iPad は「ファイル」アプリから複数選択できます。</p>

      {tracks.length === 0 ? (
        <p className="empty">まだレイヤーがありません</p>
      ) : (
        <div className="layer-list">
          {tracks.map((t, i) => (
            <TrackRow
              key={t.id}
              track={t}
              index={i}
              total={tracks.length}
              selection={selection}
              onPatch={(patch) => onPatch(t.id, patch)}
              onPatchLive={(patch) => onPatchLive(t.id, patch)}
              onBeginEdit={onBeginEdit}
              onClipPatch={onClipPatch}
              onRemove={() => onRemove(t.id)}
              onMove={(dir) => onMove(t.id, dir)}
              onRepeatFill={() => onRepeatFill(t.id)}
              grabbed={grabTrackId === t.id}
              onGrab={() => onGrab(t.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
