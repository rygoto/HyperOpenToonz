import { useRef, useState, useSyncExternalStore } from 'react'
import { cellSheetRow, isCell, sheetLength, trackFps } from '../engine/timeline.js'
import {
  EMPTY,
  fillRows,
  holdRows,
  identitySheet,
  isDefaultSheet,
  pasteCells,
  removeRows,
  repeatRows,
  reverseRows,
  setCells,
  sheetOf,
  stepRows,
} from '../engine/sheet.js'
import { useMatchMedia } from '../hooks/useMatchMedia.js'

// 表の尻より先にも、書き足せるように空の行を出しておく
const SPARE_ROWS = 12
const COL_W = 68
const NUM_W = 44

/** いま再生ヘッドが当たっている行の印。これだけが再生中に描き直される */
function NowRow({ clock, track, rowH }) {
  const st = useSyncExternalStore(clock.subscribe, clock.getSnapshot)
  let row = null
  for (const c of track.clips) {
    const r = cellSheetRow(track, c, st.time)
    if (r != null) row = r
  }
  if (row == null) return null
  return <div className="xsheet__now" style={{ top: row * rowH, height: rowH }} />
}

/** レイヤー1つぶんの列。セルが変わる行にだけ番号を出し、止めているあいだは縦線を引く */
function Column({ track, rows, rowH, lo, hi, focus, typing, clock, onPick, onFill }) {
  const sheet = sheetOf(track)
  const dragging = useRef(false)
  const colRef = useRef(null)
  // つまみを引いているあいだの行き先(離すまでは下書きとして枠だけ出す)
  const [fillTo, setFillTo] = useState(null)

  const rowAt = (e) => {
    const top = colRef.current.getBoundingClientRect().top
    return Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - top) / rowH)))
  }

  // 選んだ範囲の最後にセルが入っていれば、右下に引き伸ばしのつまみを出す
  const canFill = hi >= 0 && hi < sheet.length && sheet[hi] !== EMPTY

  const cells = []
  for (let i = 0; i < rows; i++) {
    const within = i < sheet.length
    const cell = within ? sheet[i] : EMPTY
    const head = within && cell !== EMPTY && (i === 0 || sheet[i - 1] !== cell)
    const typed = typing && i === focus
    cells.push(
      <div
        key={i}
        className={
          'xcell' +
          (within ? '' : ' is-out') +
          (cell === EMPTY ? ' is-empty' : head ? ' is-head' : ' is-hold') +
          (i >= lo && i <= hi ? ' is-selected' : '') +
          (i === focus ? ' is-focus' : '')
        }
        title={cell === EMPTY ? undefined : track.files?.[cell]}
      >
        {typed ? typing : head ? cell + 1 : ''}
      </div>,
    )
  }

  return (
    <div
      className="xsheet__col"
      ref={colRef}
      style={{ width: COL_W }}
      onPointerDown={(e) => {
        if (e.button != null && e.button !== 0) return
        // マウスは押したままなぞって範囲を選べる(指はスクロールに使う)
        if (e.pointerType === 'mouse') {
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
        }
        onPick(track.id, rowAt(e), e.shiftKey)
      }}
      onPointerMove={(e) => {
        if (dragging.current) onPick(track.id, rowAt(e), true)
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      {cells}
      <NowRow clock={clock} track={track} rowH={rowH} />
      {fillTo != null && fillTo > hi && (
        <div className="xsheet__fill" style={{ top: (hi + 1) * rowH, height: (fillTo - hi) * rowH }} />
      )}
      {fillTo != null && fillTo < hi && (
        <div className="xsheet__fill is-cut" style={{ top: (fillTo + 1) * rowH, height: (hi - fillTo) * rowH }} />
      )}
      {canFill && (
        <div
          className="xsheet__tab"
          style={{ top: (hi + 1) * rowH }}
          title="下へ引っぱるとそのコマまで伸ばし、上へ引っぱると縮めます(後ろのコマは一緒にずれます)"
          onPointerDown={(e) => {
            if (e.button != null && e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            setFillTo(hi)
          }}
          onPointerMove={(e) => {
            if (fillTo != null) setFillTo(Math.max(lo, rowAt(e)))
          }}
          onPointerUp={(e) => {
            e.stopPropagation()
            if (fillTo != null && fillTo !== hi) onFill(fillTo)
            setFillTo(null)
          }}
          onPointerCancel={() => setFillTo(null)}
        />
      )}
    </div>
  )
}

/**
 * タイムシート編集。透過セル連番のレイヤーを1列ずつ並べ、何コマ目にどのセルを出すかを直す。
 * 既定は読み込んだ順(1, 2, 3, …)。番号を打ち込むほか、伸ばす / 詰める / 繰り返す / コマ打ちができる。
 */
export default function SheetPanel({ tracks, selection, clock, onEdit, onClose }) {
  const coarse = useMatchMedia('(pointer: coarse)')
  const rowH = coarse ? 32 : 22
  const cols = tracks.filter(isCell)
  const gridRef = useRef(null)

  // 選んでいる範囲(anchor から focus まで。同じ列の中だけ)
  const [sel, setSel] = useState(() => {
    const picked = cols.find((t) => t.clips.some((c) => selection.includes(c.id)))
    return { trackId: (picked ?? cols[0])?.id ?? null, anchor: 0, focus: 0 }
  })
  const [typing, setTyping] = useState('')
  const [extend, setExtend] = useState(false)
  const [entry, setEntry] = useState('')
  const [note, setNote] = useState(null)
  // コピーしたコマ(貼れるのは同じ列だけ)
  const copied = useRef(null)

  const track = cols.find((t) => t.id === sel.trackId) ?? cols[0] ?? null
  const sheet = track ? sheetOf(track) : []
  const lo = Math.min(sel.anchor, sel.focus)
  const hi = Math.max(sel.anchor, sel.focus)
  const rows = Math.max(0, ...cols.map(sheetLength)) + SPARE_ROWS

  /** その行が映る位置へ再生ヘッドを動かす(プレビューで見ながら直せるように) */
  const seekTo = (t, row) => {
    const clip = t.clips.find((c) => row >= c.in && row < c.in + c.len)
    if (!clip) return
    clock.pause()
    clock.seek(clip.start + (row - clip.in) / trackFps(t))
  }

  const pick = (trackId, row, keep) => {
    const t = cols.find((x) => x.id === trackId)
    if (!t) return
    const same = track && trackId === track.id
    setSel({ trackId, anchor: (keep || extend) && same ? sel.anchor : row, focus: row })
    setTyping('')
    setNote(null)
    seekTo(t, row)
    gridRef.current?.focus({ preventScroll: true })
  }

  /** 編集を当てて、選択を結果の範囲に合わせる */
  const run = (result) => {
    if (!track) return
    if (result.sheet !== sheet) onEdit(track.id, result.sheet)
    setSel({ trackId: track.id, anchor: result.a, focus: result.b })
    setTyping('')
    // ボタンを押したあとも、続けてキーで操作できるように表へ戻す
    gridRef.current?.focus({ preventScroll: true })
  }

  /** 選んだ範囲に 1 始まりのセル番号を入れる(0 は空セル)。入れたら次の行へ進む */
  const enter = (text) => {
    if (!track) return
    const n = Number(text)
    if (!Number.isInteger(n) || n < 0 || n > track.frames.length) {
      setNote(`セル番号は 1〜${track.frames.length}(0 で空セル)です`)
      setTyping('')
      return
    }
    setNote(null)
    const result = setCells(sheet, lo, hi, n === 0 ? EMPTY : n - 1)
    run({ ...result, a: hi + 1, b: hi + 1 })
  }

  // コマ打ちは、1行しか選んでいなければ列ぜんぶに掛ける
  const step = (n) => run(lo === hi ? stepRows(sheet, 0, sheet.length - 1, n) : stepRows(sheet, lo, hi, n))

  const copy = () => {
    if (!track) return
    const cells = []
    for (let i = lo; i <= hi; i++) cells.push(i < sheet.length ? sheet[i] : EMPTY)
    copied.current = { trackId: track.id, cells }
    setNote(null)
  }

  /** 選んでいる範囲の先頭から、コピーしたコマを上書きで貼る */
  const paste = () => {
    const clip = copied.current
    if (!track || !clip) return
    if (clip.trackId !== track.id) {
      setNote('コピーしたコマは、同じ列にだけ貼り付けられます')
      return
    }
    setNote(null)
    run(pasteCells(sheet, lo, clip.cells))
  }

  const onKeyDown = (e) => {
    if (!track || e.altKey) return
    const used = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.ctrlKey || e.metaKey) {
      // クリップではなくコマをコピー / 貼り付けする(元に戻すなどは App に任せる)
      if (e.code === 'KeyC') {
        used()
        copy()
      } else if (e.code === 'KeyX') {
        used()
        copy()
        run(setCells(sheet, lo, hi, EMPTY))
      } else if (e.code === 'KeyV') {
        used()
        paste()
      }
      return
    }
    if (/^[0-9]$/.test(e.key)) {
      used()
      setTyping((t) => (t + e.key).slice(0, 5))
      return
    }
    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        used()
        if (typing) enter(typing)
        else pick(track.id, Math.min(rows - 1, hi + 1), false)
        return
      case 'Escape':
        if (!typing) return
        used()
        setTyping('')
        return
      case 'Backspace':
        used()
        if (typing) setTyping((t) => t.slice(0, -1))
        else run(setCells(sheet, lo, hi, EMPTY))
        return
      case 'Delete':
        used()
        run(setCells(sheet, lo, hi, EMPTY))
        return
      case 'ArrowUp':
      case 'ArrowDown': {
        used()
        const row = Math.max(0, Math.min(rows - 1, sel.focus + (e.code === 'ArrowUp' ? -1 : 1)))
        pick(track.id, row, e.shiftKey)
        return
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        used()
        const next = cols[cols.indexOf(track) + (e.code === 'ArrowLeft' ? -1 : 1)]
        if (next) pick(next.id, sel.focus, false)
        return
      }
      default:
    }
  }

  const cell = sel.focus < sheet.length ? sheet[sel.focus] : EMPTY
  const count = hi - lo + 1

  return (
    <aside className="xsheet" style={{ width: Math.max(300, NUM_W + cols.length * COL_W + 24) }}>
      <div className="xsheet__head">
        <strong>タイムシート</strong>
        <button onClick={onClose}>閉じる</button>
      </div>

      {!track ? (
        <p className="hint xsheet__empty">
          透過PNG連番を読み込むと、ここで「何コマ目にどのセルを出すか」を編集できます。
        </p>
      ) : (
        <>
          <div className="xsheet__tools">
            <button title="選んだセルをもう1コマ止める(後ろは繰り下がります)" onClick={() => run(holdRows(sheet, lo, hi))}>
              ＋伸ばす
            </button>
            <button title="選んだ行を抜く(後ろは繰り上がります)" onClick={() => run(removeRows(sheet, lo, hi))}>
              −詰める
            </button>
            <button title="選んだ範囲を、すぐ後ろにもう1回ぶん並べる" onClick={() => run(repeatRows(sheet, lo, hi))}>
              繰り返す
            </button>
            <button title="選んだ範囲の並びを逆にする" disabled={count < 2} onClick={() => run(reverseRows(sheet, lo, hi))}>
              逆順
            </button>
            <button title="選んだ行を空セル(何も出さない)にする (Del)" onClick={() => run(setCells(sheet, lo, hi, EMPTY))}>
              空セル
            </button>
          </div>
          <div className="xsheet__tools">
            <span className="dim">コマ打ち</span>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                title={`${count > 1 ? '選んだ範囲' : 'この列ぜんぶ'}を${n}コマ打ちに並べ直す`}
                onClick={() => step(n)}
              >
                {n}コマ
              </button>
            ))}
            <button
              title="この列を、読み込んだ順に1コマずつの並びへ戻す"
              disabled={isDefaultSheet(track)}
              onClick={() => run({ sheet: identitySheet(track.frames.length), a: 0, b: 0 })}
            >
              読み込み順に戻す
            </button>
          </div>
          <form
            className="xsheet__tools"
            onSubmit={(e) => {
              e.preventDefault()
              if (entry !== '') enter(entry)
              setEntry('')
            }}
          >
            <input
              type="number"
              min="0"
              max={track.frames.length}
              step="1"
              placeholder={`セル 1〜${track.frames.length}`}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
            />
            <button type="submit" disabled={entry === ''}>
              入れる
            </button>
            {coarse && (
              <button
                type="button"
                className={extend ? 'primary' : ''}
                aria-pressed={extend}
                title="オンのあいだ、タップしたところまでを範囲として選びます"
                onClick={() => setExtend((v) => !v)}
              >
                範囲選択
              </button>
            )}
          </form>

          <div className="xsheet__grid" ref={gridRef} tabIndex={0} onKeyDown={onKeyDown} style={{ '--xrow': rowH + 'px' }}>
            <div className="xsheet__cols">
              <div className="xsheet__corner" style={{ width: NUM_W }}>
                コマ
              </div>
              {cols.map((t) => (
                <button
                  key={t.id}
                  className={'xsheet__name' + (t.id === track.id ? ' is-active' : '')}
                  style={{ width: COL_W }}
                  title={`${t.name}(${t.frames.length}枚 / ${trackFps(t)}fps / ${sheetLength(t)}コマ)`}
                  onClick={() => pick(t.id, t.id === track.id ? sel.focus : 0, false)}
                >
                  <span>{t.name}</span>
                  <span className="mono dim">{trackFps(t)}fps</span>
                </button>
              ))}
            </div>
            <div className="xsheet__rows" style={{ height: rows * rowH }}>
              <div className="xsheet__nums" style={{ width: NUM_W }}>
                {Array.from({ length: rows }, (_, i) => (
                  <div key={i} className="xnum mono">
                    {i + 1}
                  </div>
                ))}
              </div>
              {cols.map((t) => {
                const mine = t.id === track.id
                return (
                  <Column
                    key={t.id}
                    track={t}
                    rows={rows}
                    rowH={rowH}
                    lo={mine ? lo : -1}
                    hi={mine ? hi : -1}
                    focus={mine ? sel.focus : -1}
                    typing={mine ? typing : ''}
                    clock={clock}
                    onPick={pick}
                    onFill={(to) => run(fillRows(sheet, lo, hi, to))}
                  />
                )
              })}
            </div>
          </div>

          <p className={'hint xsheet__status' + (note ? ' is-error' : '')}>
            {note ??
              `${lo + 1}${count > 1 ? `〜${hi + 1}` : ''}コマ目: ${
                cell === EMPTY ? '空セル' : `セル${cell + 1}(${track.files?.[cell] ?? ''})`
              } ・ 数字 → Enter で入力 / Shift+クリックで範囲 / Ctrl+C・V でコピー・貼り付け / Del で空セル`}
          </p>
        </>
      )}
    </aside>
  )
}
