import { useCallback, useState } from 'react'
import App from './App.jsx'
import { MODE_IDS, normalizeMode } from './modes.js'

const MODE_KEY = 'piyopiyo.mode'

function loadMode() {
  try {
    return normalizeMode(window.localStorage.getItem(MODE_KEY))
  } catch {
    return 'anime'
  }
}

/**
 * アニメーション / 音声付加 の切り替え。
 * 一度開いたアプリは閉じずに残しておくので、行き来しても作業は消えない
 * (見えていない側は再生を止めて、描画もしない)。
 */
export default function Root() {
  const [mode, setMode] = useState(loadMode)
  const [opened, setOpened] = useState(() => [loadMode()])
  // もう一方のアプリ宛てのシーン JSON(開いた側から渡される)
  const [handoff, setHandoff] = useState(null)

  const switchTo = useCallback((next) => {
    const m = normalizeMode(next)
    setMode(m)
    setOpened((list) => (list.includes(m) ? list : [...list, m]))
    try {
      window.localStorage.setItem(MODE_KEY, m)
    } catch {
      /* 覚えられなくても切り替えはできる */
    }
  }, [])

  const handOver = useCallback(
    (h) => {
      setHandoff(h)
      switchTo(h.mode)
    },
    [switchTo],
  )

  const handoffDone = useCallback(() => setHandoff(null), [])

  return MODE_IDS.filter((id) => opened.includes(id)).map((id) => (
    <App
      key={id}
      mode={id}
      active={id === mode}
      onMode={switchTo}
      handoff={handoff?.mode === id ? handoff : null}
      onHandOver={handOver}
      onHandoffDone={handoffDone}
    />
  ))
}
