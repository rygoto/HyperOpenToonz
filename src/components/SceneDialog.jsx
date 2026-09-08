import { useMemo, useRef, useState } from 'react'
import { filesFromDataTransfer } from '../engine/media.js'
import { assetKey, foundCount } from '../engine/scene.js'
import { isIPadLike } from '../engine/saveFile.js'

const TYPE_LABEL = { bg: '背景 / BOOK', cell: 'セル', audio: '音声' }

const canPickFolder = () => !isIPadLike() && 'webkitdirectory' in document.createElement('input')

function stamp(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/**
 * 読み込んだシーン JSON に、素材を名前で結び直してもらう画面。
 * フォルダやファイルを渡すと、シーンが要求している名前と突き合わせる。
 */
export default function SceneDialog({ scene, initialFiles, onRestore, onClose }) {
  // JSON と一緒に落ちてきた素材は最初から結んでおく(フォルダごとのドロップ)
  const [pool, setPool] = useState(() => {
    const map = new Map()
    for (const f of initialFiles ?? []) map.set(assetKey(f.name), f)
    return map
  })
  const [over, setOver] = useState(false)
  const fileInput = useRef(null)
  const dirInput = useRef(null)

  const add = (files) => {
    if (!files || files.length === 0) return
    setPool((prev) => {
      const next = new Map(prev)
      for (const f of files) next.set(assetKey(f.name), f)
      return next
    })
  }

  const rows = useMemo(
    () =>
      scene.tracks.map((t, i) => ({
        key: i,
        track: t,
        need: t.files.length,
        have: foundCount(t, pool),
      })),
    [scene, pool],
  )

  const ready = rows.filter((row) => row.have > 0).length
  const missing = rows.length - ready
  const partial = rows.some((row) => row.have > 0 && row.have < row.need)

  return (
    <div className="overlay">
      <div className="overlay__box overlay__box--wide">
        <h3 className="dialog__title">シーンを読み込む</h3>

        <p className="hint dialog__meta mono">
          {scene.tracks.length}レイヤー / {scene.stage.width}×{scene.stage.height} / {scene.project.fps}fps
          {scene.savedAt ? ` / ${stamp(scene.savedAt)}` : ''}
        </p>

        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <input
          ref={dirInput}
          type="file"
          multiple
          webkitdirectory=""
          directory=""
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />

        <div
          className={'relink__drop' + (over ? ' is-over' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setOver(false)
            add(await filesFromDataTransfer(e.dataTransfer))
          }}
        >
          <p className="hint">
            このシーンで使っていた素材を、ここへドロップするか下のボタンで選んでください。ファイル名で結び直します。
          </p>
          <div className="row">
            <button className="wide" onClick={() => fileInput.current.click()}>
              ファイルを選ぶ
            </button>
            {canPickFolder() && (
              <button className="wide" onClick={() => dirInput.current.click()}>
                フォルダを選ぶ
              </button>
            )}
          </div>
        </div>

        <div className="relink__list">
          {rows.map((row) => (
            <div
              key={row.key}
              className={'relink__row' + (row.have === 0 ? ' is-missing' : row.have < row.need ? ' is-partial' : ' is-ok')}
            >
              <span className="relink__mark" aria-hidden="true">
                {row.have === 0 ? '—' : row.have < row.need ? '△' : '✓'}
              </span>
              <span className="relink__name">
                {row.track.name}
                <em className="dim"> / {TYPE_LABEL[row.track.type]}</em>
              </span>
              <span className="relink__count mono">
                {row.need > 1 ? `${row.have} / ${row.need}枚` : row.have > 0 ? '見つかりました' : '未'}
              </span>
            </div>
          ))}
        </div>

        {missing > 0 && (
          <p className="hint">{missing}つのレイヤーは素材がまだ見つかっていません。このまま復元すると、そのレイヤーは飛ばします。</p>
        )}
        {partial && <p className="hint">コマが足りないセルは、渡した分だけで組み立てます。</p>}

        <div className="row">
          <button className="primary wide" disabled={ready === 0} onClick={() => onRestore(pool)}>
            {missing > 0 ? `${missing}つを飛ばして復元` : '復元する'}
          </button>
          <button className="wide" onClick={onClose}>
            やめる
          </button>
        </div>
      </div>
    </div>
  )
}
