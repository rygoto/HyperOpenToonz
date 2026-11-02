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
export const ROLE_LABEL = { bgm: 'BGM', se: 'SE', voice: '台詞' }

/** 台詞の話者。名前の代わりに A, B, C … で分ける */
export const SPEAKERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
export const normalizeSpeaker = (v) => (typeof v === 'string' && SPEAKERS.includes(v.toUpperCase()) ? v.toUpperCase() : undefined)

/** 音声トラックのタグの表示名。台詞は話者まで(「台詞A」など) */
export function roleLabel(track) {
  const label = ROLE_LABEL[track.role]
  if (!label) return undefined
  return track.role === 'voice' && track.speaker ? label + track.speaker : label
}

/** トラックの並びで使われている話者(A→Z の順) */
export const usedSpeakers = (tracks) =>
  SPEAKERS.filter((s) => tracks.some((t) => t.type === 'audio' && t.role === 'voice' && t.speaker === s))

/** 登録済みの話者の一覧を A→Z の順・重複なしにそろえる */
export const normalizeSpeakerList = (list) =>
  SPEAKERS.filter((s) => Array.isArray(list) && list.some((v) => normalizeSpeaker(v) === s))
