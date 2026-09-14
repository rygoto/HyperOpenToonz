import { useRef } from 'react'
import { AUDIO_ACCEPT } from '../engine/media.js'
import { clipLenSec, isVisual, minUnits, sourceUnits, unitsPerSecond } from '../engine/timeline.js'
import { ROLE_LABEL } from '../modes.js'
import Fold from './Fold.jsx'
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

/** どの表示でも出す、絵のレイヤーの要 */
function Basics({ track, onPatchLive, onBeginEdit, grabbed, onGrab }) {
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
    </>
  )
}

/** 数値での配置・合成。シンプル表示では畳んだまま使わない */
function PlaceBody({ track, onPatch }) {
  return (
    <>
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
        <NumberField
          label="回転"
          value={Number((track.rotate ?? 0).toFixed(1))}
          step={5}
          min={-180}
          max={180}
          suffix="°"
          onChange={(v) => onPatch({ rotate: v })}
        />
        <div className="presets">
          {[-90, -15, 0, 15, 90].map((d) => (
            <button key={d} className={(track.rotate ?? 0) === d ? 'is-active' : ''} onClick={() => onPatch({ rotate: d })}>
              {d === 0 ? '0°' : `${d > 0 ? '+' : ''}${d}`}
            </button>
          ))}
        </div>
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

function FpsRow({ track, onPatch, simple }) {
  return (
    <div className={simple ? '' : 'row'}>
      {!simple && (
        <NumberField
          label="セルのfps"
          value={track.fps}
          min={0.1}
          step={1}
          suffix="fps"
          onChange={(v) => onPatch({ fps: Math.max(0.1, v) })}
        />
      )}
      <div className="presets">
        {FPS_PRESETS.map((f) => (
          <button key={f} className={track.fps === f ? 'is-active' : ''} onClick={() => onPatch({ fps: f })}>
            {f}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 0.5 → -6.0dB */
function fmtDb(gain) {
  if (!(gain > 0.0001)) return '-∞dB'
  const db = 20 * Math.log10(gain)
  return `${db > 0.05 ? '+' : ''}${db.toFixed(1)}dB`
}

/** 音量(ゲイン)。0〜200%、ドラッグ中は履歴を積まずに書き換える */
function GainField({ label = '音量', track, onPatch, onPatchLive, onBeginEdit, max = 2 }) {
  const gain = track.gain ?? 1
  return (
    <div className="gain">
      <label className="field wide">
        <span className="gain__head">
          {label}
          <span className="mono dim">
            {Math.round(gain * 100)}% / {fmtDb(gain)}
          </span>
        </span>
        <input
          type="range"
          min="0"
          max={max}
          step="0.01"
          value={gain}
          onPointerDown={onBeginEdit}
          onKeyDown={onBeginEdit}
          onChange={(e) => onPatchLive({ gain: Number(e.target.value) })}
        />
      </label>
      <button
        className="gain__reset"
        title="100%(0dB)に戻す"
        disabled={gain === 1}
        onClick={() => onPatch({ gain: 1 })}
      >
        0dB
      </button>
    </div>
  )
}

function AudioBody({ track, sound, onPatch, onPatchLive, onBeginEdit, onRepeatFill }) {
  return (
    <>
      {sound && (
        <div className="presets">
          {Object.entries(ROLE_LABEL).map(([role, label]) => (
            <button
              key={role}
              className={track.role === role ? 'is-active' : ''}
              onClick={() => onPatch({ role })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <GainField track={track} onPatch={onPatch} onPatchLive={onPatchLive} onBeginEdit={onBeginEdit} />
      <label className="chk">
        <input type="checkbox" checked={track.muted} onChange={(e) => onPatch({ muted: e.target.checked })} />
        ミュート
      </label>
      {sound && (
        <button onClick={onRepeatFill} title="繰り返しは動画の尻で切ります">
          最後のクリップで尺いっぱいまで繰り返す
        </button>
      )}
      <p className="hint">
        {track.duration.toFixed(2)}秒 / {track.clips.length}クリップ
      </p>
    </>
  )
}

/** 音声付加側の動画。見た目はいじらず、動画に入っている音の大きさだけを決める */
function VideoSoundBody({ track, onPatch, onPatchLive, onBeginEdit }) {
  const extracted = !!track.buffer
  return (
    <>
      <GainField
        label="動画の音量"
        track={track}
        onPatch={onPatch}
        onPatchLive={onPatchLive}
        onBeginEdit={onBeginEdit}
        max={extracted ? 2 : 1}
      />
      <label className="chk">
        <input type="checkbox" checked={track.muted} onChange={(e) => onPatch({ muted: e.target.checked })} />
        この動画の音を消す
      </label>
      <p className="hint">
        {track.duration > 0 ? `${track.duration.toFixed(2)}秒 / ` : ''}
        {track.clips.length}クリップ
        {!extracted && ' / この動画から音声を取り出せませんでした(無音の動画かもしれません)。音量は100%までです'}
      </p>
    </>
  )
}

function trackMeta(track, sound) {
  if (track.type === 'cell') return `${track.frames.length}枚 ${track.fps}fps`
  if (track.type === 'bg') return `${KIND_LABEL[track.kind] ?? '背景'} ${track.width}×${track.height}`
  return (sound && ROLE_LABEL[track.role]) || '音声'
}

function TrackRow({
  track,
  index,
  total,
  selection,
  simple,
  sound,
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
  const cell = track.type === 'cell'
  // 音声付加側の動画は、配置や撮影処理を持たない
  const picture = visual && !sound

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
        <span className="layer__name" title={track.name}>
          {track.name}
        </span>
        <span className={'layer__meta mono' + (sound && track.role ? ' layer__meta--' + track.role : '')}>
          {trackMeta(track, sound)}
        </span>
      </summary>

      <div className="layer__body">
        {cell && <FpsRow track={track} onPatch={onPatch} simple={simple} />}

        {picture && (
          <Basics
            track={track}
            onPatchLive={onPatchLive}
            onBeginEdit={onBeginEdit}
            grabbed={grabbed}
            onGrab={onGrab}
          />
        )}

        {picture && !simple && (
          <Fold id="place" title="配置・合成" defaultOpen={false}>
            <PlaceBody track={track} onPatch={onPatch} />
            {track.type === 'bg' && track.kind === 'video' && (
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
          </Fold>
        )}

        {sound && track.type === 'bg' && (
          <VideoSoundBody track={track} onPatch={onPatch} onPatchLive={onPatchLive} onBeginEdit={onBeginEdit} />
        )}

        {track.type === 'audio' && (
          <AudioBody
            track={track}
            sound={sound}
            onPatch={onPatch}
            onPatchLive={onPatchLive}
            onBeginEdit={onBeginEdit}
            onRepeatFill={onRepeatFill}
          />
        )}

        {picture && (
          <FxPanel
            track={track}
            simple={simple}
            onBeginEdit={onBeginEdit}
            onFx={(fx) => onPatchLive({ fx })}
          />
        )}

        {only && !simple && (
          <Fold id="clip" title="選んだクリップ" meta="尺の微調整">
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
          </Fold>
        )}

        <div className="row layer__actions">
          <button disabled={index === 0} onClick={() => onMove(-1)}>
            {sound ? '▲ 上へ' : '▲ 奥へ'}
          </button>
          <button disabled={index === total - 1} onClick={() => onMove(1)}>
            {sound ? '▼ 下へ' : '▼ 手前へ'}
          </button>
          <button className="danger" onClick={onRemove}>
            削除
          </button>
        </div>
        {picture && !simple && <p className="hint">下にあるレイヤーほど手前に重なります</p>}
      </div>
    </details>
  )
}

export default function TrackPanel({
  tracks,
  selection,
  simple,
  sound = false,
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
  // 音声付加側では、同じファイル選択を BGM と SE で使い分ける
  const role = useRef(null)

  const pickAudio = (r) => {
    role.current = r
    audioInput.current.click()
  }

  return (
    <section className="panel">
      <h2 className="panel__title">{sound ? 'BGM / SE' : 'セル / 音声'}</h2>

      {!sound && (
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
      )}
      <input
        ref={audioInput}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onAddAudio(files, sound ? { role: role.current ?? 'se' } : undefined)
          e.target.value = ''
        }}
      />

      {sound ? (
        <>
          <button className="wide primary" onClick={() => pickAudio('bgm')}>
            ＋ BGM を読み込む（先頭に置く）
          </button>
          <button className="wide primary" onClick={() => pickAudio('se')}>
            ＋ SE を読み込む（再生ヘッドに置く）
          </button>
          {!simple && (
            <p className="hint">
              mp3 / wav / m4a など。1ファイルが1本の音声トラックになります。ステージへドロップした音声は SE
              として再生ヘッドの位置に置きます。BGM / SE はあとから切り替えられます。
            </p>
          )}
        </>
      ) : (
        <>
          <button className="wide primary" onClick={() => cellInput.current.click()}>
            ＋ 透過PNG連番を読み込む
          </button>
          <button className="wide" onClick={() => audioInput.current.click()}>
            ＋ 音声ファイルを読み込む (mp3 / wav …)
          </button>
          {!simple && (
            <p className="hint">
              連番はファイル名の数値順。PC はフォルダのドロップ、iPad は「ファイル」アプリから複数選択できます。
            </p>
          )}
        </>
      )}

      <h2 className="panel__title">{sound ? 'トラック' : 'レイヤー'}</h2>

      {tracks.length === 0 ? (
        <p className="empty">{sound ? 'まだトラックがありません' : 'まだレイヤーがありません'}</p>
      ) : (
        <div className="layer-list">
          {tracks.map((t, i) => (
            <TrackRow
              key={t.id}
              track={t}
              index={i}
              total={tracks.length}
              selection={selection}
              simple={simple}
              sound={sound}
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
