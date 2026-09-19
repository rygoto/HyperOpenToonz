import { useRef, useState } from 'react'
import { filesFromDataTransfer } from '../engine/media.js'
import { foundCount } from '../engine/scene.js'
import { isIPadLike } from '../engine/saveFile.js'
import { ROLE_LABEL } from '../modes.js'

const TYPE_LABEL = { bg: '背景 / BOOK', cell: 'セル', audio: '音声' }

function typeLabel(track, sound) {
  if (!sound) return TYPE_LABEL[track.type]
  if (track.type === 'bg') return '動画'
  return ROLE_LABEL[track.role] ?? '音声'
}

const canPickFolder = () => !isIPadLike() && 'webkitdirectory' in document.createElement('input')

function stamp(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/**
 * 読み込んだシーン JSON に、素材を結び直してもらう画面。
 * JSON に書いてあるパスとファイル名を手がかりに、渡された素材や
 * 覚えている素材フォルダの中身と突き合わせる。
 */
export default function SceneDialog({
  scene,
  pool,
  folders = [],
  canRemember,
  onAddFiles,
  onScanFolders,
  onRememberFolder,
  onRestore,
  onClose,
  sound = false,
}) {
  // 集めた素材は App 側が持っている(フォルダを調べている間、この画面は一度消えるため)
  const [over, setOver] = useState(false)
  const fileInput = useRef(null)
  const dirInput = useRef(null)

  const add = (files) => {
    if (files && files.length > 0) onAddFiles(files)
  }

  const scan = async (remember) => {
    if (remember && !(await onRememberFolder())) return
    await onScanFolders()
  }

  const rows = scene.tracks.map((t, i) => ({
    key: i,
    track: t,
    need: t.files.length,
    have: foundCount(t, pool),
  }))

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
          {scene.folders?.length > 0 ? ` / 📁 ${scene.folders.join(', ')}` : ''}
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
            このシーンで使っていた素材を、ここへドロップするか下のボタンで選んでください。パスとファイル名で結び直します。
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
          {canRemember && (
            <div className="row">
              {folders.length > 0 && (
                <button className="wide" onClick={() => scan(false)}>
                  🔓 覚えているフォルダから探す
                </button>
              )}
              <button className="wide" onClick={() => scan(true)}>
                📁 素材フォルダを覚えて探す
              </button>
            </div>
          )}
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
                <em className="dim"> / {typeLabel(row.track, sound)}</em>
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
