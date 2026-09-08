import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'piyopiyo.fold.'

/**
 * 開閉の覚え書き。
 * 同じ id の枠はレイヤーをまたいで同じ状態にする(セルAの「撮影処理」を開いたら
 * セルBの「撮影処理」も開いている、という揃い方のほうが迷わないため)。
 */
const open = new Map()
const subs = new Set()

function read(id, fallback) {
  if (open.has(id)) return open.get(id)
  let v = fallback
  try {
    const s = window.localStorage.getItem(KEY + id)
    if (s != null) v = s === '1'
  } catch {
    /* 読めなければ既定のまま */
  }
  open.set(id, v)
  return v
}

function write(id, v) {
  open.set(id, v)
  try {
    window.localStorage.setItem(KEY + id, v ? '1' : '0')
  } catch {
    /* 覚えられなくても開閉はできる */
  }
  for (const fn of subs) fn()
}

const subscribe = (fn) => {
  subs.add(fn)
  return () => subs.delete(fn)
}

/**
 * 畳める枠。開閉は id ごとに覚える。
 *
 * toggle を渡すと見出しに ◉ / ◯ の入切ボタンが付く。
 * 入切と開閉は別なので、切ったまま中身を詰めることも、
 * 効かせたまま畳んで場所を空けることもできる。
 */
export default function Fold({ id, title, meta, defaultOpen = true, toggle, children }) {
  const isOpen = useSyncExternalStore(
    subscribe,
    () => read(id, defaultOpen),
    () => defaultOpen,
  )
  const setOpen = useCallback((v) => write(id, v), [id])

  const on = toggle?.on
  return (
    <details className={'fold' + (toggle ? (on ? ' is-on' : ' is-off') : '')} open={isOpen}>
      <summary
        className="fold__head"
        onClick={(e) => {
          // 既定の開閉は止めて、覚えたほうの状態を動かす
          e.preventDefault()
          setOpen(!isOpen)
        }}
      >
        {toggle && (
          <button
            className={'fold__switch' + (on ? '' : ' is-off')}
            title={on ? '切る' : '入れる'}
            aria-pressed={!!on}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              toggle.onChange(!on)
            }}
          >
            {on ? '◉' : '◯'}
          </button>
        )}
        <span className="fold__title">{title}</span>
        {meta && <span className="fold__meta">{meta}</span>}
        <span className="fold__caret" aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
      </summary>
      <div className="fold__body">{children}</div>
    </details>
  )
}
