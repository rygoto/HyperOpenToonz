import { useEffect, useRef, useState } from 'react'
import { AUDIO_ACCEPT } from '../engine/media.js'
import { canDissolve, canFade, clipLenSec, dissolvePairs, dissolveSpanOf, OL_MID_DEFAULT, OL_MID_MAX, OL_MID_MIN, olMidOf, olMix, isVisual, minUnits, sourceUnits, unitsPerSecond } from '../engine/timeline.js'
import { ROLE_LABEL, roleLabel } from '../modes.js'
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

/** 秒の欄の値。0 以下は「掛けない」(キーごと外す) */
const effectSec = (v) => (v > 0 ? Math.min(30, Math.round(v * 100) / 100) : undefined)

/**
 * オーバーラップの推移の具合。重なりの真ん中で、後ろのクリップがどれだけ見えているか(%)。
 * ドラッグ中は手元の値だけ動かし、離したときに1回だけ記録する(取り消し1回ぶんにする)
 */
function OlCurveField({ clip, onPatch }) {
  const saved = olMidOf(clip)
  const [draft, setDraft] = useState(null)
  const mid = draft ?? saved
  const pct = Math.round(mid * 100)
  const apply = () => {
    if (draft == null) return
    const v = Math.round(draft * 100) / 100
    setDraft(null)
    if (Math.abs(v - saved) > 1e-9) onPatch({ olMid: Math.abs(v - OL_MID_DEFAULT) < 1e-9 ? undefined : v })
  }
  // 曲線の見本(左下 = 前のクリップだけ、右上 = 後ろのクリップだけ)
  const pts = Array.from({ length: 21 }, (_, i) => {
    const k = i / 20
    return `${(k * 40).toFixed(1)},${(20 - olMix(k, mid) * 20).toFixed(1)}`
  }).join(' ')
  const hint = pct > 55 ? '早めに次のクリップへ替わる' : pct < 45 ? '終わり際まで前のクリップが残る' : '一定の速さで替わる'
  return (
    <div className="ol-curve">
      <label className="field wide">
        <span>
          替わり方(真ん中で次のクリップが {pct}% 見える)
        </span>
        <input
          type="range"
          min={OL_MID_MIN}
          max={OL_MID_MAX}
          step={0.01}
          value={mid}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={apply}
          onKeyUp={apply}
          onBlur={apply}
        />
      </label>
      <div className="ol-curve__foot">
        <svg className="ol-curve__graph" viewBox="0 0 40 20" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={pts} />
        </svg>
        <span className="layer__effects-hint">{hint}</span>
        <button
          type="button"
          disabled={Math.abs(mid - OL_MID_DEFAULT) < 1e-9}
          title="一定の速さ(50%)に戻す"
          onClick={() => {
            setDraft(null)
            onPatch({ olMid: undefined })
          }}
        >
          戻す
        </button>
      </div>
    </div>
  )
}

/**
 * 0〜1 のつまみ(% で見せる)。ドラッグ中は手元の値だけ動かし、離したときに1回だけ onCommit する
 */
function DraftRange({ label, value, min = 0, max = 1, onCommit }) {
  const [draft, setDraft] = useState(null)
  const v = draft ?? value
  const apply = () => {
    if (draft == null) return
    const next = Math.round(draft * 100) / 100
    setDraft(null)
    if (Math.abs(next - value) > 1e-9) onCommit(next)
  }
  return (
    <label className="field wide">
      <span>
        {label} {Math.round(v * 100)}%
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={v}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={apply}
        onKeyUp={apply}
        onBlur={apply}
      />
    </label>
  )
}

/** 音声の「部屋の外」の調整(掛かっているクリップだけ) */
function MuffleFields({ clip, onPatch }) {
  return (
    <div className="muffle">
      <div className="muffle__head">
        <span>部屋の外</span>
        <button type="button" title="「部屋の外」を外す" onClick={() => onPatch({ muffle: undefined, room: undefined })}>
          外す
        </button>
      </div>
      <DraftRange label="こもり具合" value={clip.muffle} min={0.05} onCommit={(muffle) => onPatch({ muffle })} />
      <DraftRange label="響き" value={clip.room ?? 0} onCommit={(room) => onPatch({ room: room > 0 ? room : undefined })} />
      <p className="layer__effects-hint">こもり具合を上げるほど分厚い壁の向こうに、響きを上げるほど広い部屋の中から聞こえます</p>
    </div>
  )
}

/** 音声の「伝声管」の調整(掛かっているクリップだけ) */
function TubeFields({ clip, onPatch }) {
  return (
    <div className="muffle">
      <div className="muffle__head">
        <span>伝声管</span>
        <button type="button" title="「伝声管」を外す" onClick={() => onPatch({ tube: undefined, pipe: undefined })}>
          外す
        </button>
      </div>
      <DraftRange label="管の細さ" value={clip.tube} min={0.05} onCommit={(tube) => onPatch({ tube })} />
      <DraftRange label="管の長さ(反響)" value={clip.pipe ?? 0} onCommit={(pipe) => onPatch({ pipe: pipe > 0 ? pipe : undefined })} />
      <p className="layer__effects-hint">細くするほど帯域が狭く鼻にかかった声に、長くするほど管の中でカンカンと反響します</p>
    </div>
  )
}

/**
 * 選んだクリップに掛けたエフェクトの調整。
 *   音のフェード … フェードを掛けられるクリップならいつも出す(0 で外す)
 *   オーバーラップ … 掛かっているクリップ(前後のうち後ろ)だけ。掛けるのは再生バーの「エフェクト」から。
 *                    長さはタイムライン上のクリップの重なりそのもの
 */
function ClipEffectsFields({ track, clip, olPairs, onPatch }) {
  const fade = canFade(track)
  const visual = canDissolve(track)
  const marked = visual && clip.dissolve > 0
  const span = marked ? dissolveSpanOf(olPairs, clip.id) : null
  if (!fade && !visual) return null
  return (
    <div className="layer__effects">
      <div className="layer__effects-title">選んだクリップのエフェクト</div>
      {marked && (
        <div className="row">
          <span className="layer__effects-hint">
            {span
              ? `オーバーラップ ${(span.to - span.from).toFixed(2)}s(前のクリップとの重なり。長さはタイムラインで重なりを変えて調整)`
              : 'オーバーラップ: 前のクリップと重なっていないので効いていません(タイムラインで重ねると効きます)'}
          </span>
          <button type="button" title="オーバーラップを外す" onClick={() => onPatch({ dissolve: undefined, olMid: undefined })}>
            外す
          </button>
        </div>
      )}
      {marked && <OlCurveField key={clip.id} clip={clip} onPatch={onPatch} />}
      {visual && !marked && (
        <p className="layer__effects-hint">
          オーバーラップなし。掛けるには、前後に並んだ2つのクリップを選んで再生バーの「エフェクト ▾」から(クリップが重なっている区間だけに効きます)
        </p>
      )}
      {fade && (
        <div className="row">
          <NumberField
            label="フェードイン"
            value={clip.fadeIn ?? 0}
            step={0.1}
            min={0}
            max={30}
            suffix="s"
            onChange={(v) => onPatch({ fadeIn: effectSec(v) })}
          />
          <NumberField
            label="フェードアウト"
            value={clip.fadeOut ?? 0}
            step={0.1}
            min={0}
            max={30}
            suffix="s"
            onChange={(v) => onPatch({ fadeOut: effectSec(v) })}
          />
        </div>
      )}
      {fade && <p className="layer__effects-hint">0 でフェードなし</p>}
      {fade && clip.muffle > 0 && <MuffleFields key={clip.id} clip={clip} onPatch={onPatch} />}
      {fade && clip.tube > 0 && <TubeFields key={`tube-${clip.id}`} clip={clip} onPatch={onPatch} />}
      {fade && !(clip.muffle > 0 && clip.tube > 0) && (
        <p className="layer__effects-hint">「部屋の外」(こもった声)と「伝声管」(管から出てくる声)は再生バーの「エフェクト ▾」から掛けられます</p>
      )}
    </div>
  )
}

/**
 * クリップの名前。打つたびに履歴が積まれないよう、確定(フォーカスを外す / Enter)したときだけ反映する。
 * Esc で打ちかけを捨てる。空にすると名前を外す(トラックの名前で表示・書き出し)。
 * 別のクリップを選んだ / 取り消したときは、呼ぶ側が key を変えて作り直す。
 */
function ClipNameField({ clip, placeholder, onChange }) {
  const [draft, setDraft] = useState(clip.name ?? '')
  const apply = () => {
    const name = draft.trim()
    if (name !== (clip.name ?? '')) onChange(name || undefined)
    else setDraft(clip.name ?? '')
  }
  return (
    <label className="field wide">
      選んだクリップの名前
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
          else if (e.key === 'Escape') {
            setDraft(clip.name ?? '')
            e.currentTarget.blur()
          }
        }}
      />
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

      <label className="chk">
        <input type="checkbox" checked={!!track.flipX} onChange={(e) => onPatch({ flipX: e.target.checked })} />
        ⇆ 左右反転
      </label>
    </>
  )
}

/** 別のレイヤーへ写す、配置と撮影処理の項目(fps・表示/非表示・素材は写さない) */
const LOOK_KEYS = ['fit', 'opacity', 'scale', 'rotate', 'flipX', 'x', 'y', 'blend']

function lookOf(track) {
  const look = {}
  for (const k of LOOK_KEYS) if (track[k] !== undefined) look[k] = track[k]
  look.fx = structuredClone(track.fx ?? null)
  return look
}

/**
 * 配置・撮影処理のコピーと貼り付け。
 * コピーしたものはパネルが覚えておき、他のレイヤーを開くと貼り付けられる。
 */
function LookCopy({ track, copied, otherCells, onCopy, onPaste, onPasteAllCells }) {
  const mine = copied?.from === track.id
  return (
    <div className="look-copy">
      <div className="row">
        <button
          className={mine ? 'is-active' : ''}
          title="拡大率・位置・回転・反転・配置・合成・不透明度と、撮影処理をコピーします"
          onClick={onCopy}
        >
          {mine ? '✓ コピー済み' : '📋 配置・撮影処理をコピー'}
        </button>
        {copied && !mine && (
          <button className="primary" title={`「${copied.name}」の配置と撮影処理をこのレイヤーへ写します`} onClick={onPaste}>
            📥 貼り付け
          </button>
        )}
      </div>
      {copied && mine && otherCells > 0 && (
        <button className="wide" onClick={onPasteAllCells}>
          ほかの連番 {otherCells} 本すべてへ貼り付け
        </button>
      )}
      {copied && !mine && <p className="hint">コピー元: {copied.name}</p>}
    </div>
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

/**
 * 台詞の話者を、登録済みの話者から選ぶ。
 * 「＋」は話者を登録するだけ(空いている一番若い文字)。このトラックへ付けるのは文字のボタンで選ぶ。
 * 右クリックで、どのトラックにも付いていない話者の登録を取り消す。
 */
function SpeakerPicker({ track, speakers, onPatch, onAddSpeaker, onRemoveSpeaker }) {
  const shown = track.speaker && !speakers.includes(track.speaker) ? [...speakers, track.speaker].sort() : speakers
  const canAdd = speakers.length < 26
  return (
    <div className="presets speakers" title="話者ごとに Resolve のトラックを分けます">
      <span className="speakers__label">話者</span>
      <button className={track.speaker ? '' : 'is-active'} onClick={() => onPatch({ speaker: undefined })}>
        なし
      </button>
      {shown.map((s) => (
        <button
          key={s}
          className={track.speaker === s ? 'is-active' : ''}
          title={`話者 ${s} をこのトラックに付ける(右クリックで登録を取り消し)`}
          onClick={() => onPatch({ speaker: s })}
          onContextMenu={(e) => {
            e.preventDefault()
            onRemoveSpeaker?.(s)
          }}
        >
          {s}
        </button>
      ))}
      {canAdd && (
        <button title="話者を登録する(このトラックには付けません)" onClick={onAddSpeaker}>
          ＋
        </button>
      )}
    </div>
  )
}

function AudioBody({ track, sound, speakers, onAddSpeaker, onRemoveSpeaker, onPatch, onPatchLive, onBeginEdit, onRepeatFill }) {
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
      {sound && track.role === 'voice' && <SpeakerPicker track={track} speakers={speakers} onPatch={onPatch} onAddSpeaker={onAddSpeaker} onRemoveSpeaker={onRemoveSpeaker} />}
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

/** 音声付加側の動画に入っている音の大きさを決める */
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
  return (sound && roleLabel(track)) || '音声'
}

function TrackRow({
  track,
  index,
  total,
  selection,
  simple,
  sound,
  speakers,
  onAddSpeaker,
  onRemoveSpeaker,
  onPatch,
  onPatchLive,
  onBeginEdit,
  onClipPatch,
  onRemove,
  onMove,
  onRepeatFill,
  grabbed,
  onGrab,
  copied,
  otherCells,
  onCopyLook,
  onPasteLook,
  onPasteLookAllCells,
  olPairs,
}) {
  const selected = track.clips.filter((c) => selection.includes(c.id))
  const only = selected.length === 1 ? selected[0] : null
  const visual = isVisual(track)
  const cell = track.type === 'cell'
  // 音声付加側の動画は配置を持たない(色調・フィルターは撮影処理と同じものをかけられる)
  const picture = visual && !sound

  // タイムラインでクリップを1つ選んだら、そのトラックを開いて名前の欄を見えるところへ出す
  const rowRef = useRef(null)
  const clipRef = useRef(null)
  const onlyId = only?.id
  useEffect(() => {
    if (!onlyId || !rowRef.current) return
    rowRef.current.open = true
    clipRef.current?.scrollIntoView({ block: 'nearest' })
  }, [onlyId])

  return (
    <details ref={rowRef} className={'layer' + (grabbed ? ' is-grabbed' : '')} open={index === 0}>
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
        {only && (
          <div ref={clipRef} className="layer__clip">
            <ClipNameField
              key={`${only.id}:${only.name ?? ''}`}
              clip={only}
              placeholder={track.name}
              onChange={(name) => onClipPatch(track.id, only.id, { name })}
            />
            <ClipEffectsFields track={track} clip={only} olPairs={olPairs} onPatch={(patch) => onClipPatch(track.id, only.id, patch)} />
            {!simple && (
              <Fold id="clip" title="選んだクリップの尺" meta="開始・長さ" defaultOpen={false}>
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
                          Math.min(v * unitsPerSecond(track), Math.max(sourceUnits(track) - only.in, only.len)),
                        ),
                      })
                    }
                  />
                </div>
              </Fold>
            )}
          </div>
        )}

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

        {picture && (
          <LookCopy
            track={track}
            copied={copied}
            otherCells={otherCells}
            onCopy={onCopyLook}
            onPaste={onPasteLook}
            onPasteAllCells={onPasteLookAllCells}
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

        {sound && track.type === 'bg' && track.kind === 'video' && (
          <VideoSoundBody track={track} onPatch={onPatch} onPatchLive={onPatchLive} onBeginEdit={onBeginEdit} />
        )}

        {track.type === 'audio' && (
          <AudioBody
            track={track}
            sound={sound}
            speakers={speakers}
            onAddSpeaker={onAddSpeaker}
            onRemoveSpeaker={onRemoveSpeaker}
            onPatch={onPatch}
            onPatchLive={onPatchLive}
            onBeginEdit={onBeginEdit}
            onRepeatFill={onRepeatFill}
          />
        )}

        {visual && (
          <FxPanel
            track={track}
            title={sound ? '🎨 色調・フィルター' : undefined}
            simple={simple}
            onBeginEdit={onBeginEdit}
            onFx={(fx) => onPatchLive({ fx })}
          />
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
  onPasteLook,
  onRemove,
  onMove,
  onRepeatFill,
  speakers = [],
  onAddSpeaker,
  onRemoveSpeaker,
  grabTrackId,
  onGrab,
}) {
  const cellInput = useRef(null)
  const audioInput = useRef(null)
  // 音声付加側では、同じファイル選択を BGM と SE で使い分ける
  const role = useRef(null)
  // コピーした配置・撮影処理 { from: トラックid, name, look }
  const [copied, setCopied] = useState(null)
  const cellIds = tracks.filter((t) => t.type === 'cell').map((t) => t.id)
  const olPairs = dissolvePairs(tracks)

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
              として再生ヘッドの位置に置きます。BGM / SE / 台詞 はあとから切り替えられます。
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
              olPairs={olPairs}
              selection={selection}
              simple={simple}
              sound={sound}
              speakers={speakers}
              onAddSpeaker={onAddSpeaker}
              onRemoveSpeaker={onRemoveSpeaker}
              onPatch={(patch) => onPatch(t.id, patch)}
              onPatchLive={(patch) => onPatchLive(t.id, patch)}
              onBeginEdit={onBeginEdit}
              onClipPatch={onClipPatch}
              onRemove={() => onRemove(t.id)}
              onMove={(dir) => onMove(t.id, dir)}
              onRepeatFill={() => onRepeatFill(t.id)}
              grabbed={grabTrackId === t.id}
              onGrab={() => onGrab(t.id)}
              copied={copied}
              otherCells={cellIds.filter((id) => id !== t.id).length}
              onCopyLook={() => setCopied({ from: t.id, name: t.name, look: lookOf(t) })}
              onPasteLook={() => copied && onPasteLook([t.id], copied.look)}
              onPasteLookAllCells={() =>
                copied && onPasteLook(cellIds.filter((id) => id !== copied.from), copied.look)
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}
