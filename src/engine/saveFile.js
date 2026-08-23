/** iPad / iPhone（デスクトップ表示の iPadOS を含む） */
export function isIPadLike() {
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/**
 * 書き出した Blob を保存する。
 * iPad は共有シート、PC はダウンロード。どちらもユーザー操作の直後に呼ぶこと。
 */
export async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
  if (isIPadLike() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 8000)
  return 'downloaded'
}

export function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}
