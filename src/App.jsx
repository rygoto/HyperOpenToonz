import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClock } from './engine/clock.js'
import { createAudioEngine, decodeAudioFile, decodeVideoAudio } from './engine/audio.js'
import { MODE_IDS, MODES, ROLE_LABEL } from './modes.js'
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
  trimTrackTo,
} from './engine/timeline.js'
import { filePath, kindOf, loadBackground, loadCellSequence, sortByName } from './engine/media.js'
import Stage from './components/Stage.jsx'
import Transport from './components/Transport.jsx'
import Timeline from './components/Timeline.jsx'
import BackgroundPanel from './components/BackgroundPanel.jsx'
import TrackPanel from './components/TrackPanel.jsx'
import ExportDialog from './components/ExportDialog.jsx'
import ScenePanel from './components/ScenePanel.jsx'
import SceneDialog from './components/SceneDialog.jsx'
import { exportComposedVideo } from './engine/exportVideo.js'
import { clearFxCache, defaultFx } from './engine/fx.js'
import {
  addToPool,
  makePool,
  parseScene,
  poolCoversScene,
  restoreScene,
  sceneToText,
  serializeScene,
  SCENE_EXT,
} from './engine/scene.js'
import {
  canRememberFolders,
  collectFromFolders,
  forgetSourceFolder,
  listSourceFolders,
  rememberSourceFolder,
} from './engine/assetLibrary.js'
import {
  fileStamp,
  forgetExportDirectory,
  loadExportDirectory,
  pickExportDirectory,
  reauthorizeDirectory,
  saveBlob,
  withExtension,
} from './engine/saveFile.js'
import { useMatchMedia } from './hooks/useMatchMedia.js'

const DEFAULT_CELL_FPS = 8
const FALLBACK_DURATION = 5
const HISTORY_LIMIT = 100

// 上下分割(プレビュー / タイムライン)の下限
const MIN_TIMELINE_H = 96
const MIN_STAGE_H = 140
const SPLIT_KEY = 'piyopiyo.timelineHeight'
const SIMPLE_KEY = 'piyopiyo.simple'

function loadSimple() {
  try {
    return window.localStorage.getItem(SIMPLE_KEY) === '1'
  } catch {
    return false
  }
}

function loadSplit() {
  try {
    const v = Number(window.localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(v) && v >= MIN_TIMELINE_H ? v : null
  } catch {
    return null
  }
}

/** cutA_0001.png → cutA */
function nameFromFiles(files) {
  const base = files[0].name.replace(/\.[^.]+$/, '')
  return base.replace(/[_\-. ]*\d+$/, '') || base
}

/**
 * 編集画面ひとつぶん。mode で中身が変わる。
 *   anime … 背景 / BOOK + 透過セル連番 + 音声(撮影処理あり)
 *   sound … 動画 + BGM / SE(動画の切り貼りと音量の調整。撮影処理・連番は無し)
 * active でないあいだは隠れて、再生も描画も止まる(作業は残る)。
 */
export default function App({
  mode = 'anime',
  active = true,
  onMode,
  handoff = null,
  onHandOver,
  onHandoffDone,
}) {
  const cfg = MODES[mode] ?? MODES.anime
  const sound = cfg.id === 'sound'

  const clockRef = useRef(null)
  if (!clockRef.current) clockRef.current = createClock()
  const clock = clockRef.current

  const audioRef = useRef(null)
  if (!audioRef.current) audioRef.current = createAudioEngine()
  const audio = audioRef.current

  const [tracks, setTracks] = useState([])
  const [selection, setSelection] = useState([])
  const [stage, setStage] = useState({
    width: 1920,
    height: 1080,
    autoSize: true,
    bgColor: '#000000',
    checker: true,
  })
  const [projectFps, setProjectFps] = useState(cfg.fps)
  // 書き出す動画の fps。プロジェクト fps(コマ送りの単位)とは別に決める
  const [exportFps, setExportFps] = useState(24)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const [exportResult, setExportResult] = useState(null)
  const compact = useMatchMedia('(max-width: 960px)')

  // ステージ上での直接操作(移動・拡縮)
  const [grab, setGrab] = useState(false)
  const [grabTrackId, setGrabTrackId] = useState(null)

  // シンプル表示: 数値や細かい調整を隠して、作業に要るものだけ出す
  const [simple, setSimple] = useState(loadSimple)

  // 読み込んだシーン JSON(素材を結び直すのを待っている状態)と、そこまでに集まった素材
  const [sceneDoc, setSceneDoc] = useState(null)
  const [scenePool, setScenePool] = useState(null)

  // 覚えている素材フォルダ(シーンを開いたとき、ここから自動で結び直す)
  const [folders, setFolders] = useState([])

  // 書き出しの設定
  const [exportOpen, setExportOpen] = useState(false)
  const [exportName, setExportName] = useState('')
  const [exportDir, setExportDir] = useState(null)
  const [askWhere, setAskWhere] = useState(false)

  // タイムラインの高さ(null = CSS の既定値)
  const [tlHeight, setTlHeight] = useState(loadSplit)
  const viewerRef = useRef(null)
  const tlRef = useRef(null)
  const split = useRef(null)
  const lastTap = useRef(0)

  // 描画ループやショートカットから最新値を読むためのミラー
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const history = useRef({ past: [], future: [] })
  const clipboard = useRef([])

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
    const d = projectDurationSec(tracks)
    clock.setDuration(d > 0 ? d : FALLBACK_DURATION)
  }, [tracks, clock])

  useEffect(() => {
    if (!stage.autoSize) return
    // 背景があればその解像度、無ければ最初のセルに合わせる
    const src =
      tracks.find((t) => t.type === 'bg' && t.width > 0) ??
      tracks.find((t) => t.type === 'cell' && t.width > 0)
    if (!src) return
    setStage((s) =>
      s.width === src.width && s.height === src.height ? s : { ...s, width: src.width, height: src.height },
    )
  }, [tracks, stage.autoSize])

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

  // もう一方のアプリに切り替えたら、こちらは止めておく
  useEffect(() => {
    if (active) return
    clock.pause()
    setGrab(false)
  }, [active, clock])

  // ---------- 上下分割 ----------
  const clampTl = useCallback((h) => {
    const room = viewerRef.current?.clientHeight ?? 0
    const max = room > 0 ? Math.max(MIN_TIMELINE_H, room - MIN_STAGE_H) : Infinity
    return Math.round(Math.max(MIN_TIMELINE_H, Math.min(h, max)))
  }, [])

  const resetSplit = useCallback(() => {
    setTlHeight(null)
    try {
      window.localStorage.removeItem(SPLIT_KEY)
    } catch {
      /* 保存できなくても動作に支障はない */
    }
  }, [])

  const storeSplit = useCallback((h) => {
    setTlHeight(h)
    try {
      window.localStorage.setItem(SPLIT_KEY, String(h))
    } catch {
      /* noop */
    }
  }, [])

  // 画面の回転やウィンドウサイズの変化で潰れないように詰め直す
  useEffect(() => {
    const el = viewerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setTlHeight((h) => (h == null ? h : clampTl(h)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [clampTl])

  const onSplitDown = useCallback(
    (e) => {
      if (e.button != null && e.button !== 0) return
      // タッチのダブルタップで既定値に戻す
      if (e.pointerType !== 'mouse') {
        const now = performance.now()
        if (now - lastTap.current < 320) {
          lastTap.current = 0
          resetSplit()
          return
        }
        lastTap.current = now
      }
      e.preventDefault()
      const h = tlRef.current?.getBoundingClientRect().height ?? MIN_TIMELINE_H
      split.current = { y: e.clientY, base: h }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [resetSplit],
  )

  const onSplitMove = useCallback(
    (e) => {
      const d = split.current
      if (!d) return
      storeSplit(clampTl(d.base - (e.clientY - d.y)))
    },
    [clampTl, storeSplit],
  )

  const onSplitUp = useCallback(() => {
    split.current = null
  }, [])

  const onSplitKey = useCallback(
    (e) => {
      const step = e.shiftKey ? 48 : 12
      let next = null
      if (e.code === 'ArrowUp') next = (tlRef.current?.getBoundingClientRect().height ?? 0) + step
      else if (e.code === 'ArrowDown') next = (tlRef.current?.getBoundingClientRect().height ?? 0) - step
      else if (e.code === 'Home' || e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        resetSplit()
        return
      }
      if (next == null) return
      e.preventDefault()
      e.stopPropagation()
      storeSplit(clampTl(next))
    },
    [clampTl, resetSplit, storeSplit],
  )

  // ---------- 素材の読み込み ----------
  /**
   * 背景 / BOOK を1枚のレイヤーとして足す。
   * 既定では一番奥(配列の先頭)。onTop なら一番手前に置く。
   */
  const addBackgroundTrack = useCallback(
    async (file, { onTop = false } = {}) => {
      setBusy({ label: `${file.name} を読み込み中…` })
      try {
        const src = await loadBackground(file)
        const len =
          src.kind === 'video' && src.duration > 0
            ? src.duration
            : Math.max(FALLBACK_DURATION, projectDurationSec(tracksRef.current))
        const track = {
          id: nextId('track'),
          type: 'bg',
          kind: src.kind,
          name: src.name,
          fileName: file.name,
          path: filePath(file),
          el: src.el,
          url: src.url,
          width: src.width,
          height: src.height,
          duration: src.duration,
          fit: 'contain',
          opacity: 1,
          scale: 1,
          rotate: 0,
          x: 0,
          y: 0,
          blend: 'source-over',
          fx: defaultFx(),
          visible: true,
          muted: false,
          clips: [],
        }
        track.clips = [makeClip(track, { start: 0, len })]
        commit((prev) => (onTop ? [...prev, track] : [track, ...prev]))
        say(`${src.name} を${onTop ? 'BOOK(手前)' : '背景'}レイヤーにしました`)
      } catch (e) {
        say(e.message, 'error')
      } finally {
        setBusy(null)
      }
    },
    [commit, say],
  )

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
          files: seq.names,
          paths: seq.paths,
          frames: seq.frames,
          width: seq.width,
          height: seq.height,
          fps: DEFAULT_CELL_FPS,
          opacity: 1,
          scale: 1,
          rotate: 0,
          x: 0,
          y: 0,
          fit: 'contain',
          blend: 'source-over',
          fx: defaultFx(),
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

  /**
   * 音声付加側: 動画を読み込む。1本目は先頭、2本目からは今ある動画の後ろへつなげる。
   * 動画に入っている音は取り出しておき、Web Audio で鳴らす(ゲインと波形のため)。
   */
  const addVideoTracks = useCallback(
    async (files) => {
      const list = sortByName(files.filter((f) => kindOf(f) === 'video'))
      if (list.length === 0) {
        say('動画ファイルが見つかりませんでした', 'error')
        return
      }
      const made = []
      let at = Math.max(0, ...tracksRef.current.filter((t) => t.type === 'bg').map(trackEndSec))
      let failed = null
      try {
        for (let i = 0; i < list.length; i++) {
          const file = list[i]
          setBusy({ label: `${file.name} を読み込み中…`, done: i, total: list.length })
          const src = await loadBackground(file)
          setBusy({ label: `${file.name} の音声を取り出し中…`, done: i, total: list.length })
          const extracted = await decodeVideoAudio(file)
          const track = {
            id: nextId('track'),
            type: 'bg',
            kind: src.kind,
            name: src.name,
            fileName: file.name,
            path: filePath(file),
            el: src.el,
            url: src.url,
            width: src.width,
            height: src.height,
            duration: src.duration,
            fit: 'contain',
            opacity: 1,
            scale: 1,
            rotate: 0,
            x: 0,
            y: 0,
            blend: 'source-over',
            fx: defaultFx(),
            visible: true,
            muted: false,
            gain: 1,
            buffer: extracted?.buffer ?? null,
            peaks: extracted?.peaks ?? null,
            clips: [],
          }
          track.clips = [makeClip(track, { start: at, len: src.duration > 0 ? src.duration : FALLBACK_DURATION })]
          at = trackEndSec(track)
          made.push(track)
        }
      } catch (e) {
        failed = e
      } finally {
        setBusy(null)
      }
      if (made.length > 0) {
        commit((prev) => {
          // 動画は音声トラックより上にまとめておく
          const next = [...prev]
          next.splice(prev.findLastIndex((t) => t.type === 'bg') + 1, 0, ...made)
          return next
        })
      }
      if (failed) say(failed.message || '動画を読み込めませんでした', 'error')
      else if (made.length === 1) say(`${made[0].name} を ${made[0].clips[0].start.toFixed(2)}秒の位置に置きました`)
      else say(`${made.length}本の動画をつなげて置きました`)
    },
    [commit, say],
  )

  const addAudioTracks = useCallback(
    async (files, { role } = {}) => {
      const list = files.filter((f) => kindOf(f) === 'audio')
      if (list.length === 0) {
        say('音声ファイルが見つかりませんでした', 'error')
        return
      }
      // SE は再生ヘッドの位置、BGM とアニメーション側の音声は先頭に置く
      const at = role === 'se' ? clock.peek().time : 0
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
            fileName: file.name,
            path: filePath(file),
            buffer: src.buffer,
            peaks: src.peaks,
            duration: src.duration,
            ...(role ? { role } : {}),
            gain: 1,
            muted: false,
            clips: [],
          }
          track.clips = [makeClip(track, { start: at })]
          made.push(track)
          setBusy({ label: '音声をデコード中…', done: i + 1, total: list.length })
        }
        commit((prev) => [...prev, ...made])
        say(
          role
            ? `${made.length}件の${ROLE_LABEL[role]}を${role === 'se' ? `${at.toFixed(2)}秒の位置` : '先頭'}に置きました`
            : `${made.length}件の音声を読み込みました`,
        )
      } catch (e) {
        say(`音声を読み込めません: ${e.message}`, 'error')
      } finally {
        setBusy(null)
      }
    },
    [clock, commit, say],
  )

  // ---------- トラック操作 ----------
  const patchTrack = useCallback(
    (id, patch) => commit((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [commit],
  )

  /**
   * ドラッグ中の更新。履歴は掴んだ瞬間に onBeginEdit で1回だけ積むので、
   * ここでは積まずに現在の状態だけ書き換える。
   */
  const patchTrackLive = useCallback(
    (id, patch) => applyTracks(tracksRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t))),
    [applyTracks],
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
        if (sound) {
          // 音声付加側は動画の尻まで埋めて、はみ出した分は切る(動画が無ければ他のトラックの一番長いところ)
          const videos = prev.filter((t) => t.type === 'bg' && t.id !== id)
          const others = videos.length > 0 ? videos : prev.filter((t) => t.id !== id)
          const end = Math.max(0, ...others.map(trackEndSec))
          if (!(end > 0)) return prev
          return prev.map((t) => (t.id === id ? trimTrackTo(repeatToFill(t, end), end) : t))
        }
        // 埋める先は「自分以外」の一番長いところ。何も無ければ既定の尺まで。
        const end = Math.max(
          FALLBACK_DURATION,
          ...prev.map((t) => (t.id === id ? 0 : trackEndSec(t))),
        )
        return prev.map((t) => (t.id === id ? repeatToFill(t, end) : t))
      }),
    [commit, sound],
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

  /**
   * 選択中のクリップを消す。
   * クリップが1つも残らなかったレイヤーは丸ごと畳む(切り取りのときは貼り付け先として残す)。
   */
  const deleteSelection = useCallback(
    (opts) => {
      const dropEmpty = opts?.dropEmpty !== false
      const sel = selectionRef.current
      if (sel.length === 0) return
      let emptied = 0
      commit((prev) => {
        const next = []
        let changed = false
        for (const tr of prev) {
          if (!tr.clips.some((c) => sel.includes(c.id))) {
            next.push(tr)
            continue
          }
          changed = true
          const clips = tr.clips.filter((c) => !sel.includes(c.id))
          if (clips.length === 0 && dropEmpty) {
            emptied++
            continue
          }
          next.push({ ...tr, clips })
        }
        return changed ? next : prev
      })
      setSelection([])
      if (emptied > 0) say(`空になった${emptied}つのレイヤーを削除しました`)
    },
    [commit, say],
  )

  const cutSelection = useCallback(() => {
    // 切り取り直後に貼り戻せるよう、空になってもレイヤーは残す
    if (copySelection()) deleteSelection({ dropEmpty: false })
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
    // 隠れている側のアプリはキーを拾わない
    if (!active) return
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
    active,
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

  const changeExportName = useCallback((name) => {
    setExportName(name)
    try {
      window.localStorage.setItem(cfg.nameKey, name)
    } catch {
      /* noop */
    }
  }, [cfg.nameKey])

  /** 素材が揃ったので、今の内容をシーンで置き換える(元に戻すで戻れる) */
  const applyScene = useCallback(
    async (doc, pool, { auto = false } = {}) => {
      if (!doc) return
      setSceneDoc(null)
      setScenePool(null)
      setBusy({ label: 'シーンを復元中…', done: 0, total: doc.tracks.length })
      try {
        const out = await restoreScene(doc, pool, {
          onProgress: (done, total, label) => setBusy({ label, done, total }),
        })
        if (out.tracks.length === 0) {
          say('素材が見つからず、復元できませんでした', 'error')
          return
        }
        // 中身がそっくり入れ替わるので、焼き溜めた撮影処理はここで手放す
        clearFxCache()
        commit(out.tracks)
        setSelection([])
        setStage(out.stage)
        setProjectFps(out.projectFps)
        setExportFps(out.exportFps)
        setMuted(out.muted)
        setVolume(out.volume)
        if (out.name) changeExportName(out.name)
        clock.stop()
        say(
          out.skipped.length > 0
            ? `シーンを復元しました(素材が見つからない${out.skipped.length}レイヤーは飛ばしました)`
            : auto
              ? '同じ場所の素材が見つかったので、そのまま復元しました'
              : 'シーンを復元しました',
        )
      } catch (e) {
        say(e?.message || 'シーンを復元できませんでした', 'error')
      } finally {
        setBusy(null)
      }
    },
    [changeExportName, clock, commit, say],
  )

  // ---------- 素材フォルダ ----------
  // 覚えているフォルダは起動時に拾っておく(許可が切れていても名前は出す)
  useEffect(() => {
    let alive = true
    listSourceFolders().then((list) => {
      if (alive) setFolders(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const rememberFolder = useCallback(async () => {
    try {
      const picked = await rememberSourceFolder()
      if (!picked) return null
      setFolders(await listSourceFolders())
      say(`📁 ${picked.name} を素材フォルダとして覚えました`)
      return picked
    } catch (e) {
      if (e?.name !== 'AbortError') say(e?.message || 'フォルダを覚えられませんでした', 'error')
      return null
    }
  }, [say])

  /** 結び直し中の素材を足す(ドロップやファイル選択、フォルダ探索の結果) */
  const addSceneFiles = useCallback((files) => {
    if (!files || files.length === 0) return
    setScenePool((prev) => ({ ...addToPool(prev ?? makePool([]), files) }))
  }, [])

  const forgetFolder = useCallback(async (id) => {
    await forgetSourceFolder(id)
    setFolders(await listSourceFolders())
  }, [])

  /** 覚えているフォルダから、このシーンが要る素材を拾う(許可が要ればここで訊く) */
  const scanFolders = useCallback(
    async (doc) => {
      try {
        const found = await collectFromFolders(doc, {
          request: true,
          onProgress: (done, total, label) => setBusy({ label, done, total }),
        })
        setFolders(await listSourceFolders())
        return found
      } catch (e) {
        say(e?.message || 'フォルダを読めませんでした', 'error')
        return { files: [], blocked: [], used: [] }
      } finally {
        setBusy(null)
      }
    },
    [say],
  )

  // ---------- シーンを開く ----------
  /**
   * JSON を開く。
   * 一緒に落ちてきた素材(フォルダごとのドロップなど)と、覚えている素材フォルダの
   * 中身を先に当たってみて、全部そろえば何も訊かずにそのまま復元する。
   * 足りないぶんがあるときだけ、素材を結び直す画面を出す。
   */
  const openScene = useCallback(
    async (file, withFiles = []) => {
      let doc
      try {
        doc = parseScene(await file.text())
      } catch (e) {
        say(e?.message || 'シーンを読み込めませんでした', 'error')
        return
      }
      // もう一方のアプリで作ったシーンなら、そちらへ切り替えて開いてもらう
      if (doc.mode !== cfg.id && onHandOver) {
        onHandOver({ mode: doc.mode, file, files: withFiles })
        return
      }
      clock.pause()
      setExportOpen(false)
      setAssetsOpen(false)

      const pool = makePool(withFiles)
      if (!poolCoversScene(doc, pool) && canRememberFolders()) {
        const found = await scanFolders(doc)
        addToPool(pool, found.files)
      }

      if (poolCoversScene(doc, pool)) {
        await applyScene(doc, pool, { auto: true })
        return
      }
      setScenePool(pool)
      setSceneDoc(doc)
    },
    [applyScene, cfg.id, clock, onHandOver, say, scanFolders],
  )

  // もう一方のアプリから回ってきたシーン JSON を開く
  const handled = useRef(null)
  useEffect(() => {
    if (!active || !handoff || handled.current === handoff) return
    handled.current = handoff
    onHandoffDone?.()
    say(`${cfg.label}のシーンなので、${cfg.label}に切り替えました`)
    openScene(handoff.file, handoff.files)
  }, [active, cfg.label, handoff, onHandoffDone, openScene, say])

  // ---------- ドラッグ＆ドロップ ----------
  const onDropFiles = useCallback(
    (files) => {
      // シーン JSON は素材ではなく、読み込み画面へ回す
      const scene = files.find((f) => /\.json$/i.test(f.name) || f.type === 'application/json')
      if (scene) {
        openScene(
          scene,
          files.filter((f) => f !== scene),
        )
        return
      }
      const audioFiles = files.filter((f) => kindOf(f) === 'audio')
      if (sound) {
        // 音声付加側: 音声は SE として再生ヘッドへ、動画はつなげて置く。絵は受け付けない
        const videos = files.filter((f) => kindOf(f) === 'video')
        if (audioFiles.length) addAudioTracks(audioFiles, { role: 'se' })
        else if (videos.length) addVideoTracks(videos)
        else say('音声付加では動画と音声ファイルを読み込めます', 'error')
        return
      }
      if (audioFiles.length) {
        addAudioTracks(audioFiles)
        return
      }
      const video = files.find((f) => kindOf(f) === 'video')
      if (video) {
        addBackgroundTrack(video)
        return
      }
      const images = files.filter((f) => kindOf(f) === 'image')
      if (images.length === 0) {
        say('対応していないファイルです', 'error')
        return
      }
      // 1枚だけで背景がまだ無いときは背景として扱う
      if (images.length === 1 && !tracksRef.current.some((t) => t.type === 'bg')) {
        addBackgroundTrack(images[0])
        return
      }
      addCellTrack(images)
    },
    [addAudioTracks, addBackgroundTrack, addCellTrack, addVideoTracks, openScene, say, sound],
  )

  // 覚えている保存先フォルダを起動時に拾う(許可が切れていても名前は出す)
  useEffect(() => {
    let alive = true
    loadExportDirectory().then((d) => {
      if (alive) setExportDir(d)
    })
    return () => {
      alive = false
    }
  }, [])

  const openExport = useCallback(() => {
    if (tracksRef.current.length === 0) {
      say('書き出す素材がありません', 'error')
      return
    }
    clock.pause()
    setAssetsOpen(false)
    setExportName((prev) => {
      if (prev) return prev
      let stored = ''
      try {
        stored = window.localStorage.getItem(cfg.nameKey) || ''
      } catch {
        /* noop */
      }
      return stored || `${cfg.filePrefix}-${fileStamp()}`
    })
    setExportOpen(true)
  }, [cfg, clock, say])

  const toggleSimple = useCallback(() => {
    setSimple((v) => {
      const next = !v
      try {
        window.localStorage.setItem(SIMPLE_KEY, next ? '1' : '0')
      } catch {
        /* 覚えられなくても切り替えはできる */
      }
      return next
    })
  }, [])

  const chooseExportDir = useCallback(async () => {
    const picked = await pickExportDirectory()
    if (picked) {
      setExportDir(picked)
      setAskWhere(false)
    }
  }, [])

  const dropExportDir = useCallback(async () => {
    await forgetExportDirectory()
    setExportDir(null)
  }, [])

  const startExport = useCallback(async () => {
    const duration = projectDurationSec(tracksRef.current)
    if (tracksRef.current.length === 0) {
      say('書き出す素材がありません', 'error')
      return
    }
    const dur = duration > 0 ? duration : FALLBACK_DURATION
    setExportOpen(false)
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
          bgColor: stage.bgColor,
          checker: false,
          tracks: tracksRef.current,
        },
        duration: dur,
        fps: exportFps,
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
      setExportResult({ blob, filename: withExtension(exportName || `${cfg.filePrefix}-${fileStamp()}`, ext) })
      say('書き出しが完了しました。保存してください')
    } catch (e) {
      if (e?.name === 'AbortError') say('書き出しをキャンセルしました')
      else say(e?.message || '書き出しに失敗しました', 'error')
    } finally {
      setBusy(null)
      setFrozen(false)
    }
  }, [cfg.filePrefix, clock, exportFps, exportName, muted, say, stage, volume])

  /**
   * 覚えているフォルダ(あれば許可を取り直して)へ書き出す。
   * ボタンを押したその操作の中から呼ぶこと。
   */
  const saveOut = useCallback(
    async (blob, filename, description) => {
      let dir = exportDir
      // 前に選んだフォルダは、保存を押したこの操作の中で許可を取り直す
      if (dir && !dir.granted) {
        const ok = await reauthorizeDirectory(dir.handle)
        if (ok) {
          dir = { ...dir, granted: true }
          setExportDir(dir)
        } else {
          dir = null
          say('フォルダへの書き込みが許可されなかったので、ダウンロードにします')
        }
      }
      return saveBlob(blob, filename, { dir: dir?.handle ?? null, askWhere, description })
    },
    [askWhere, exportDir, say],
  )

  const saveExport = useCallback(async () => {
    if (!exportResult) return
    try {
      const result = await saveOut(exportResult.blob, exportResult.filename, '動画')
      if (result.how === 'cancelled') return
      setExportResult(null)
      if (result.how === 'folder') say(`📁 ${result.folder} に ${result.name} を保存しました`)
      else say(`${result.name} を保存しました`)
    } catch (e) {
      say(e?.message || '保存できませんでした', 'error')
    }
  }, [exportResult, saveOut, say])

  // ---------- シーンの保存と復元 ----------
  const saveScene = useCallback(async () => {
    if (tracksRef.current.length === 0) {
      say('保存するレイヤーがありません', 'error')
      return
    }
    const doc = serializeScene({
      tracks: tracksRef.current,
      stage,
      projectFps,
      exportFps,
      muted,
      volume,
      name: exportName,
      folders,
      mode: cfg.id,
    })
    const blob = new Blob([sceneToText(doc)], { type: 'application/json' })
    const filename = withExtension(exportName || `${cfg.filePrefix}-${fileStamp()}`, SCENE_EXT)
    try {
      const result = await saveOut(blob, filename, 'シーン')
      if (result.how === 'cancelled') return
      if (result.how === 'folder') say(`📁 ${result.folder} に ${result.name} を保存しました`)
      else say(`${result.name} を保存しました`)
    } catch (e) {
      say(e?.message || 'シーンを保存できませんでした', 'error')
    }
  }, [cfg, exportFps, exportName, folders, muted, projectFps, saveOut, say, stage, volume])

  const view = useMemo(
    () => ({
      width: stage.width,
      height: stage.height,
      bgColor: stage.bgColor,
      checker: stage.checker && !tracks.some((t) => t.type === 'bg'),
      tracks,
      muted,
      volume,
      frozen,
      asleep: !active,
    }),
    [stage, tracks, muted, volume, frozen, active],
  )

  return (
    <div className={'app app--' + cfg.id + (compact ? ' app--compact' : '')} hidden={!active}>
      <header className="topbar">
        <div className="topbar__brand">
          <h1>PiyopiyoToonz</h1>
          <div className="modes" role="tablist" aria-label="アプリの切り替え">
            {MODE_IDS.map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={id === cfg.id}
                className={id === cfg.id ? 'is-active' : ''}
                onClick={() => onMode?.(id)}
              >
                {MODES[id].label}
              </button>
            ))}
          </div>
          <span className="topbar__sub">{cfg.sub}</span>
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
          <button
            className={simple ? 'primary' : ''}
            title={simple ? '細かい調整も出す' : '作業に要るものだけにする'}
            onClick={toggleSimple}
          >
            {simple ? 'くわしく' : 'シンプル'}
          </button>
          <button className="primary" disabled={!!busy || frozen} onClick={openExport}>
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
            onAdd={addBackgroundTrack}
            onAddVideos={addVideoTracks}
            stage={stage}
            onStage={(patch) => setStage((s) => ({ ...s, ...patch }))}
            simple={simple}
            sound={sound}
          />
          <TrackPanel
            tracks={tracks}
            selection={selection}
            simple={simple}
            sound={sound}
            onAddCells={addCellTrack}
            onAddAudio={addAudioTracks}
            onPatch={patchTrack}
            onPatchLive={patchTrackLive}
            onBeginEdit={pushHistory}
            onClipPatch={patchClip}
            onRemove={removeTrack}
            onMove={moveTrack}
            onRepeatFill={repeatFill}
            grabTrackId={grab ? grabTrackId : null}
            onGrab={(id) => {
              setGrabTrackId(id)
              setGrab(true)
              setAssetsOpen(false)
            }}
          />
          <ScenePanel
            onSave={saveScene}
            onOpen={openScene}
            canSave={tracks.length > 0}
            simple={simple}
            sound={sound}
            folders={folders}
            canRemember={canRememberFolders()}
            onRememberFolder={rememberFolder}
            onForgetFolder={forgetFolder}
          />
        </aside>

        <main
          className="viewer"
          ref={viewerRef}
          style={tlHeight == null ? undefined : { '--tl-h': tlHeight + 'px' }}
        >
          <Stage
            clock={clock}
            audio={audio}
            view={view}
            onDropFiles={onDropFiles}
            grab={grab}
            onGrab={setGrab}
            grabTrackId={grabTrackId}
            onGrabTrack={setGrabTrackId}
            onBeginEdit={pushHistory}
            onPatchTrack={patchTrackLive}
            canGrab={!sound}
          />
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
            simple={simple}
          />
          <div
            className="splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="プレビューとタイムラインの境界"
            title="ドラッグで高さを変更 / ダブルタップで元に戻す"
            tabIndex={0}
            onPointerDown={onSplitDown}
            onPointerMove={onSplitMove}
            onPointerUp={onSplitUp}
            onPointerCancel={onSplitUp}
            onDoubleClick={resetSplit}
            onKeyDown={onSplitKey}
          >
            <span className="splitter__grip" />
          </div>
          <Timeline
            ref={tlRef}
            clock={clock}
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

      {exportOpen && !busy && (
        <ExportDialog
          filename={exportName}
          onFilename={changeExportName}
          fps={exportFps}
          onFps={setExportFps}
          dir={exportDir}
          onPickDir={chooseExportDir}
          onForgetDir={dropExportDir}
          askWhere={askWhere}
          onAskWhere={setAskWhere}
          meta={{
            width: stage.width,
            height: stage.height,
            duration: Math.max(projectDurationSec(tracks), 0) || FALLBACK_DURATION,
            muted,
            ext: 'mp4',
          }}
          onStart={startExport}
          onClose={() => setExportOpen(false)}
        />
      )}

      {sceneDoc && !busy && (
        <SceneDialog
          scene={sceneDoc}
          pool={scenePool}
          folders={folders}
          canRemember={canRememberFolders()}
          onAddFiles={addSceneFiles}
          onScanFolders={async () => addSceneFiles((await scanFolders(sceneDoc)).files)}
          onRememberFolder={rememberFolder}
          onRestore={(pool) => applyScene(sceneDoc, pool)}
          sound={sound}
          onClose={() => {
            setSceneDoc(null)
            setScenePool(null)
          }}
        />
      )}

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
            {exportDir && <p className="hint">保存先: 📁 {exportDir.name}</p>}
            <div className="row">
              <button className="primary wide" onClick={saveExport}>
                {exportDir ? 'フォルダに保存' : '保存 / 共有'}
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
