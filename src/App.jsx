import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClock } from './engine/clock.js'
import { createAudioEngine, decodeAudioFile } from './engine/audio.js'
import { nextId } from './engine/ids.js'
import {
  clipContains,
  clipEndSec,
  makeClip,
  projectDurationSec,
  repeatToFill,
  sortClips,
  splitClip,
  trackEndSec,
} from './engine/timeline.js'
import {
  disposeBackground,
  kindOf,
  loadBackground,
  loadCellSequence,
  sortByName,
} from './engine/media.js'
import Stage from './components/Stage.jsx'
import Transport from './components/Transport.jsx'
import Timeline from './components/Timeline.jsx'
import BackgroundPanel from './components/BackgroundPanel.jsx'
import TrackPanel from './components/TrackPanel.jsx'
import { exportComposedVideo } from './engine/exportVideo.js'
import { fileStamp, saveBlob } from './engine/saveFile.js'
import { useMatchMedia } from './hooks/useMatchMedia.js'

const DEFAULT_CELL_FPS = 12
const FALLBACK_DURATION = 5
const HISTORY_LIMIT = 100

/** cutA_0001.png → cutA */
function nameFromFiles(files) {
  const base = files[0].name.replace(/\.[^.]+$/, '')
  return base.replace(/[_\-. ]*\d+$/, '') || base
}

export default function App() {
  const clockRef = useRef(null)
  if (!clockRef.current) clockRef.current = createClock()
  const clock = clockRef.current

  const audioRef = useRef(null)
  if (!audioRef.current) audioRef.current = createAudioEngine()
  const audio = audioRef.current

  const [background, setBackground] = useState(null)
  const [tracks, setTracks] = useState([])
  const [selection, setSelection] = useState([])
  const [stage, setStage] = useState({
    width: 1920,
    height: 1080,
    autoSize: true,
    bgFit: 'contain',
    bgColor: '#000000',
    checker: true,
  })
  const [projectFps, setProjectFps] = useState(24)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const [exportResult, setExportResult] = useState(null)
  const compact = useMatchMedia('(max-width: 960px)')

  // 描画ループやショートカットから最新値を読むためのミラー
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const backgroundRef = useRef(background)
  backgroundRef.current = background
  const history = useRef({ past: [], future: [] })
  const clipboard = useRef([])
  const trash = useRef([])

  const say = useCallback((message, tone = 'info') => {
    setNotice({ message, tone })
    window.clearTimeout(say.timer)
    say.timer = window.setTimeout(() => setNotice(null), 4000)
  }, [])

  // ---------- 編集履歴 ----------
  const applyTracks = useCallback((next) => {
    tracksRef.current = next
    setTracks(next)
  }, [])

  const pushHistory = useCallback(() => {
    const h = history.current
    h.past.push(tracksRef.current)
    if (h.past.length > HISTORY_LIMIT) h.past.shift()
    h.future.length = 0
  }, [])

  const commit = useCallback(
    (updater) => {
      const prev = tracksRef.current
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (next === prev) return
      pushHistory()
      applyTracks(next)
    },
    [applyTracks, pushHistory],
  )

  const undo = useCallback(() => {
    const h = history.current
    if (h.past.length === 0) return
    const prev = h.past.pop()
    h.future.push(tracksRef.current)
    applyTracks(prev)
    say('元に戻しました')
  }, [applyTracks, say])

  const redo = useCallback(() => {
    const h = history.current
    if (h.future.length === 0) return
    const next = h.future.pop()
    h.past.push(tracksRef.current)
    applyTracks(next)
    say('やり直しました')
  }, [applyTracks, say])

  // ---------- 尺・解像度 ----------
  useEffect(() => {
    const d = projectDurationSec(tracks, background)
    clock.setDuration(d > 0 ? d : FALLBACK_DURATION)
  }, [background, tracks, clock])

  useEffect(() => {
    if (!stage.autoSize) return
    const src =
      background && background.width > 0
        ? background
        : tracks.find((t) => t.type === 'cell' && t.width > 0)
    if (!src) return
    setStage((s) =>
      s.width === src.width && s.height === src.height ? s : { ...s, width: src.width, height: src.height },
    )
  }, [background, tracks, stage.autoSize])

  // 差し替えた背景の解放は、描画ループが新しい view を掴んだ後に行う
  useEffect(() => {
    if (trash.current.length === 0) return
    const dead = trash.current
    trash.current = []
    for (const fn of dead) fn()
  }, [background])

  // AudioContext は最初のユーザー操作で起こす
  useEffect(() => {
    const unlock = () => audio.unlock()
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [audio])

  useEffect(() => () => audio.dispose(), [audio])

  // ---------- 素材の読み込み ----------
  const pickBackground = useCallback(
    async (file) => {
      setBusy({ label: `${file.name} を読み込み中…` })
      try {
        const bg = await loadBackground(file)
        const prev = backgroundRef.current
        if (prev) trash.current.push(() => disposeBackground(prev))
        backgroundRef.current = bg
        setBackground(bg)
        clock.pause()
        clock.seek(0)
      } catch (e) {
        say(e.message, 'error')
      } finally {
        setBusy(null)
      }
    },
    [clock, say],
  )

  const clearBackground = useCallback(() => {
    const prev = backgroundRef.current
    if (prev) trash.current.push(() => disposeBackground(prev))
    backgroundRef.current = null
    setBackground(null)
  }, [])

  const addCellTrack = useCallback(
    async (files) => {
      const images = sortByName(files.filter((f) => kindOf(f) === 'image'))
      if (images.length === 0) {
        say('画像ファイルが見つかりませんでした', 'error')
        return
      }
      setBusy({ label: 'セルをデコード中…', done: 0, total: images.length })
      try {
        const seq = await loadCellSequence(images, (done, total) =>
          setBusy({ label: 'セルをデコード中…', done, total }),
        )
        const track = {
          id: nextId('track'),
          type: 'cell',
          name: nameFromFiles(images),
          frames: seq.frames,
          width: seq.width,
          height: seq.height,
          fps: DEFAULT_CELL_FPS,
          opacity: 1,
          scale: 1,
          x: 0,
          y: 0,
          fit: 'contain',
          blend: 'source-over',
          visible: true,
          clips: [],
        }
        track.clips = [makeClip(track, { start: 0 })]
        commit((prev) => [...prev, track])
        say(`${images.length}枚のセルを読み込みました`)
      } catch (e) {
        say(e.message, 'error')
      } finally {
        setBusy(null)
      }
    },
    [commit, say],
  )

  const addAudioTracks = useCallback(
    async (files) => {
      const list = files.filter((f) => kindOf(f) === 'audio')
      if (list.length === 0) {
        say('音声ファイルが見つかりませんでした', 'error')
        return
      }
      setBusy({ label: '音声をデコード中…', done: 0, total: list.length })
      const made = []
      try {
        for (let i = 0; i < list.length; i++) {
          const file = list[i]
          const src = await decodeAudioFile(file)
          const track = {
            id: nextId('track'),
            type: 'audio',
            name: file.name.replace(/\.[^.]+$/, ''),
            buffer: src.buffer,
            peaks: src.peaks,
            duration: src.duration,
            gain: 1,
            muted: false,
            clips: [],
          }
          track.clips = [makeClip(track, { start: 0 })]
          made.push(track)
          setBusy({ label: '音声をデコード中…', done: i + 1, total: list.length })
        }
        commit((prev) => [...prev, ...made])
        say(`${made.length}件の音声を読み込みました`)
      } catch (e) {
        say(`音声を読み込めません: ${e.message}`, 'error')
      } finally {
        setBusy(null)
      }
    },
    [commit, say],
  )

  // ---------- トラック操作 ----------
  const patchTrack = useCallback(
    (id, patch) => commit((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [commit],
  )

  const patchClip = useCallback(
    (trackId, clipId, patch) =>
      commit((prev) =>
        prev.map((t) =>
          t.id === trackId
            ? { ...t, clips: sortClips(t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c))) }
            : t,
        ),
      ),
    [commit],
  )

  const removeTrack = useCallback(
    (id) => commit((prev) => prev.filter((t) => t.id !== id)),
    [commit],
  )

  const moveTrack = useCallback(
    (id, dir) =>
      commit((prev) => {
        const i = prev.findIndex((t) => t.id === id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= prev.length) return prev
        const next = [...prev]
        ;[next[i], next[j]] = [next[j], next[i]]
        return next
      }),
    [commit],
  )

  const repeatFill = useCallback(
    (id) =>
      commit((prev) => {
        // 埋める先は「自分以外」の一番長いところ。何も無ければ既定の尺まで。
        const end = Math.max(
          background?.duration ?? 0,
          FALLBACK_DURATION,
          ...prev.map((t) => (t.id === id ? 0 : trackEndSec(t))),
        )
        return prev.map((t) => (t.id === id ? repeatToFill(t, end) : t))
      }),
    [background, commit],
  )

  // ---------- クリップ編集 ----------
  const splitAtPlayhead = useCallback(() => {
    const time = clock.peek().time
    const sel = selectionRef.current
    let hit = 0
    commit((prev) =>
      prev.map((tr) => {
        let changed = false
        const clips = []
        for (const c of tr.clips) {
          const targeted = sel.length === 0 || sel.includes(c.id)
          if (targeted && clipContains(tr, c, time)) {
            const parts = splitClip(tr, c, time)
            if (parts) {
              clips.push(...parts)
              changed = true
              hit++
              continue
            }
          }
          clips.push(c)
        }
        return changed ? { ...tr, clips: sortClips(clips) } : tr
      }),
    )
    say(hit > 0 ? `${hit}個のクリップを分割しました` : '再生ヘッド上に分割できるクリップがありません', hit > 0 ? 'info' : 'error')
  }, [clock, commit, say])

  const copySelection = useCallback(() => {
    const sel = selectionRef.current
    if (sel.length === 0) return false
    const groups = []
    for (const tr of tracksRef.current) {
      const clips = tr.clips.filter((c) => sel.includes(c.id))
      if (clips.length) groups.push({ trackId: tr.id, type: tr.type, clips: clips.map((c) => ({ ...c })) })
    }
    clipboard.current = groups
    return true
  }, [])

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current
    if (sel.length === 0) return
    commit((prev) =>
      prev.map((tr) =>
        tr.clips.some((c) => sel.includes(c.id))
          ? { ...tr, clips: tr.clips.filter((c) => !sel.includes(c.id)) }
          : tr,
      ),
    )
    setSelection([])
  }, [commit])

  const cutSelection = useCallback(() => {
    if (copySelection()) deleteSelection()
  }, [copySelection, deleteSelection])

  const paste = useCallback(() => {
    const groups = clipboard.current
    if (!groups || groups.length === 0) return
    const at = clock.peek().time
    const base = Math.min(...groups.flatMap((g) => g.clips.map((c) => c.start)))
    const created = []
    const next = tracksRef.current.map((tr) => {
      const g = groups.find((x) => x.trackId === tr.id)
      if (!g) return tr
      const add = g.clips.map((c) => {
        const clip = { ...c, id: nextId('clip'), start: Math.max(0, at + (c.start - base)) }
        created.push(clip.id)
        return clip
      })
      return { ...tr, clips: sortClips([...tr.clips, ...add]) }
    })
    if (created.length === 0) {
      say('貼り付け先のトラックがありません', 'error')
      return
    }
    commit(next)
    setSelection(created)
  }, [clock, commit, say])

  const duplicateSelection = useCallback(() => {
    const sel = selectionRef.current
    if (sel.length === 0) return
    const created = []
    commit((prev) =>
      prev.map((tr) => {
        const picked = tr.clips.filter((c) => sel.includes(c.id))
        if (picked.length === 0) return tr
        const add = picked.map((c) => {
          const clip = { ...c, id: nextId('clip'), start: clipEndSec(tr, c) }
          created.push(clip.id)
          return clip
        })
        return { ...tr, clips: sortClips([...tr.clips, ...add]) }
      }),
    )
    if (created.length) setSelection(created)
  }, [commit])

  const nudgeSelection = useCallback(
    (frames) => {
      const sel = selectionRef.current
      if (sel.length === 0) return false
      const d = frames / projectFps
      commit((prev) =>
        prev.map((tr) =>
          tr.clips.some((c) => sel.includes(c.id))
            ? {
                ...tr,
                clips: sortClips(
                  tr.clips.map((c) => (sel.includes(c.id) ? { ...c, start: Math.max(0, c.start + d) } : c)),
                ),
              }
            : tr,
        ),
      )
      return true
    },
    [commit, projectFps],
  )

  // ---------- キーボード ----------
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const mod = e.ctrlKey || e.metaKey

      if (mod) {
        switch (e.code) {
          case 'KeyB':
            e.preventDefault()
            splitAtPlayhead()
            return
          case 'KeyC':
            e.preventDefault()
            if (copySelection()) say('コピーしました')
            return
          case 'KeyX':
            e.preventDefault()
            cutSelection()
            return
          case 'KeyV':
            e.preventDefault()
            paste()
            return
          case 'KeyD':
            e.preventDefault()
            duplicateSelection()
            return
          case 'KeyZ':
            e.preventDefault()
            e.shiftKey ? redo() : undo()
            return
          case 'KeyY':
            e.preventDefault()
            redo()
            return
          default:
            return
        }
      }

      if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (e.code === 'Escape') {
        setSelection([])
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        clock.toggle()
        return
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const dir = e.code === 'ArrowLeft' ? -1 : 1
        e.preventDefault()
        if (e.altKey) {
          if (nudgeSelection(dir)) return
        }
        clock.stepFrames(dir * (e.shiftKey ? projectFps : 1), projectFps)
        return
      }
      if (e.code === 'Home') {
        e.preventDefault()
        clock.stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    clock,
    copySelection,
    cutSelection,
    deleteSelection,
    duplicateSelection,
    nudgeSelection,
    paste,
    projectFps,
    redo,
    say,
    splitAtPlayhead,
    undo,
  ])

  // ---------- ドラッグ＆ドロップ ----------
  const onDropFiles = useCallback(
    (files) => {
      const audioFiles = files.filter((f) => kindOf(f) === 'audio')
      if (audioFiles.length) {
        addAudioTracks(audioFiles)
        return
      }
      const video = files.find((f) => kindOf(f) === 'video')
      if (video) {
        pickBackground(video)
        return
      }
      const images = files.filter((f) => kindOf(f) === 'image')
      if (images.length === 0) {
        say('対応していないファイルです', 'error')
        return
      }
      if (images.length === 1 && !backgroundRef.current) {
        pickBackground(images[0])
        return
      }
      addCellTrack(images)
    },
    [addAudioTracks, addCellTrack, pickBackground, say],
  )

  const startExport = useCallback(async () => {
    const duration = projectDurationSec(tracksRef.current, backgroundRef.current)
    if (!backgroundRef.current && tracksRef.current.length === 0) {
      say('書き出す素材がありません', 'error')
      return
    }
    const dur = duration > 0 ? duration : FALLBACK_DURATION
    clock.pause()
    setAssetsOpen(false)
    const ac = new AbortController()
    setFrozen(true)
    setExportResult(null)
    setBusy({
      label: 'MP4 を書き出し中…',
      done: 0,
      total: 1,
      onCancel: () => ac.abort(),
    })
    try {
      const blob = await exportComposedVideo({
        view: {
          width: stage.width,
          height: stage.height,
          background: backgroundRef.current,
          bgFit: stage.bgFit,
          bgColor: stage.bgColor,
          checker: false,
          tracks: tracksRef.current,
        },
        duration: dur,
        fps: projectFps,
        volume: muted ? 0 : volume,
        signal: ac.signal,
        onProgress: (done, total, label) =>
          setBusy({
            label: label || 'MP4 を書き出し中…',
            done,
            total,
            onCancel: () => ac.abort(),
          }),
      })
      const ext = (blob.type || '').includes('webm') ? 'webm' : 'mp4'
      setExportResult({ blob, filename: `PiyopiyoToonz-${fileStamp()}.${ext}` })
      say('書き出しが完了しました。保存してください')
    } catch (e) {
      if (e?.name === 'AbortError') say('書き出しをキャンセルしました')
      else say(e?.message || '書き出しに失敗しました', 'error')
    } finally {
      setBusy(null)
      setFrozen(false)
    }
  }, [clock, muted, projectFps, say, stage, volume])

  const saveExport = useCallback(async () => {
    if (!exportResult) return
    try {
      const result = await saveBlob(exportResult.blob, exportResult.filename)
      if (result !== 'cancelled') {
        say('保存しました')
        setExportResult(null)
      }
    } catch (e) {
      say(e?.message || '保存できませんでした', 'error')
    }
  }, [exportResult, say])

  const view = useMemo(
    () => ({
      width: stage.width,
      height: stage.height,
      background,
      bgFit: stage.bgFit,
      bgColor: stage.bgColor,
      checker: stage.checker && !background,
      tracks,
      muted,
      volume,
      frozen,
    }),
    [stage, background, tracks, muted, volume, frozen],
  )

  return (
    <div className={'app' + (compact ? ' app--compact' : '')}>
      <header className="topbar">
        <div className="topbar__brand">
          <h1>PiyopiyoToonz</h1>
          <span className="topbar__sub">背景 × 透過セル連番 コンポジター</span>
        </div>
        {notice && <div className={'notice notice--' + notice.tone}>{notice.message}</div>}
        <div className="topbar__actions">
          {compact && (
            <button
              className={assetsOpen ? 'primary' : ''}
              onClick={() => setAssetsOpen((v) => !v)}
            >
              {assetsOpen ? '閉じる' : '素材'}
            </button>
          )}
          <button className="primary" disabled={!!busy || frozen} onClick={startExport}>
            MP4書き出し
          </button>
        </div>
      </header>

      <div className="app__body">
        {compact && assetsOpen && (
          <button className="drawer-backdrop" aria-label="素材パネルを閉じる" onClick={() => setAssetsOpen(false)} />
        )}
        <aside
          className={'sidebar' + (compact && assetsOpen ? ' is-open' : '')}
          aria-hidden={compact && !assetsOpen}
        >
          {compact && (
            <div className="sidebar__drawer-head">
              <strong>素材</strong>
              <button onClick={() => setAssetsOpen(false)}>閉じる</button>
            </div>
          )}
          <BackgroundPanel
            background={background}
            onPick={pickBackground}
            onClear={clearBackground}
            stage={stage}
            onStage={(patch) => setStage((s) => ({ ...s, ...patch }))}
          />
          <TrackPanel
            tracks={tracks}
            selection={selection}
            onAddCells={addCellTrack}
            onAddAudio={addAudioTracks}
            onPatch={patchTrack}
            onClipPatch={patchClip}
            onRemove={removeTrack}
            onMove={moveTrack}
            onRepeatFill={repeatFill}
          />
        </aside>

        <main className="viewer">
          <Stage clock={clock} audio={audio} view={view} onDropFiles={onDropFiles} />
          <Transport
            clock={clock}
            projectFps={projectFps}
            onProjectFps={setProjectFps}
            muted={muted}
            onMuted={setMuted}
            volume={volume}
            onVolume={setVolume}
            selectionCount={selection.length}
            onSplit={splitAtPlayhead}
            onDelete={deleteSelection}
            onCopy={() => {
              if (copySelection()) say('コピーしました')
            }}
            onCut={cutSelection}
            onPaste={paste}
            onDuplicate={duplicateSelection}
            onUndo={undo}
            onRedo={redo}
          />
          <Timeline
            clock={clock}
            background={background}
            tracks={tracks}
            projectFps={projectFps}
            selection={selection}
            onSelection={setSelection}
            onBeginEdit={pushHistory}
            onTracksChange={applyTracks}
            onTrackPatch={(id, patch) =>
              applyTracks(tracksRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)))
            }
          />
        </main>
      </div>

      {busy && (
        <div className="overlay">
          <div className="overlay__box">
            <p>{busy.label}</p>
            {busy.total > 0 && (
              <>
                <progress value={busy.done} max={busy.total} />
                <p className="mono dim">
                  {busy.done} / {busy.total}
                </p>
              </>
            )}
            {busy.onCancel && (
              <button className="wide" onClick={busy.onCancel}>
                キャンセル
              </button>
            )}
          </div>
        </div>
      )}

      {exportResult && !busy && (
        <div className="overlay">
          <div className="overlay__box">
            <p>書き出しが完了しました</p>
            <p className="hint">{exportResult.filename}</p>
            <div className="row">
              <button className="primary wide" onClick={saveExport}>
                保存 / 共有
              </button>
              <button className="wide" onClick={() => setExportResult(null)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
