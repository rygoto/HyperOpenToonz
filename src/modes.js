/**
 * 左上で切り替える2つのアプリ。
 *
 *   anime … 背景と透過セル連番を重ねるアニメーション側(もとからあるほう)
 *   sound … 動画を土台に BGM / SE を並べる音声付加側
 *
 * 画面の作りは同じで、読み込めるものと出す設定だけが違う。
 */
export const MODES = {
  anime: {
    id: 'anime',
    label: 'アニメーション',
    sub: '背景 × 透過セル連番 コンポジター',
    fps: 24,
    filePrefix: 'PiyopiyoToonz',
    nameKey: 'piyopiyo.exportName',
  },
  sound: {
    id: 'sound',
    label: '音声付加',
    sub: '動画 × BGM / SE',
    fps: 24,
    filePrefix: 'PiyopiyoToonz-sound',
    nameKey: 'piyopiyo.sound.exportName',
  },
}

export const MODE_IDS = Object.keys(MODES)

export const normalizeMode = (v) => (v === 'sound' ? 'sound' : 'anime')

/** 音声トラックの役割。音声付加側でだけ使う */
export const ROLE_LABEL = { bgm: 'BGM', se: 'SE' }
