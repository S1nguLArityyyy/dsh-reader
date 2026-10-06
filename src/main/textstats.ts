import { nativeImage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** 统计一段 XHTML 里的可见字符数（去掉标签、脚本、空白） */
export function countVisibleChars(html: string): number {
  const withoutHidden = html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const text = withoutHidden
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
  return text.replace(/\s+/g, '').length
}

/** 逐章统计字数，用于按阅读位置计算全书进度 */
export async function countChapterChars(
  cacheDir: string,
  opfDir: string,
  chapterHrefs: string[]
): Promise<number[]> {
  const counts: number[] = []
  for (const href of chapterHrefs) {
    const rel = opfDir ? join(opfDir, href).split('/').join(sep) : href.split('/').join(sep)
    try {
      const raw = await readFile(join(cacheDir, rel), 'utf8')
      counts.push(countVisibleChars(raw))
    } catch {
      counts.push(0)
    }
  }
  return counts
}

/**
 * 取封面主色：把封面缩到 16×16，挑一个饱和度高、明度适中的像素。
 * 用于「继续阅读」卡片的渐变底色。
 */
export function coverColorOf(coverFile: string | null): string | null {
  if (!coverFile) return null
  try {
    const image = nativeImage.createFromPath(coverFile)
    if (image.isEmpty()) return null
    const small = image.resize({ width: 16, height: 16, quality: 'good' })
    const size = small.getSize()
    const bitmap = small.toBitmap() // BGRA
    let best = { score: -1, r: 0, g: 0, b: 0 }

    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const i = (y * size.width + x) * 4
        const b = bitmap[i] ?? 0
        const g = bitmap[i + 1] ?? 0
        const r = bitmap[i + 2] ?? 0
        const a = bitmap[i + 3] ?? 255
        if (a < 180) continue
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const saturation = max === 0 ? 0 : (max - min) / max
        const value = max / 255
        // 偏好在中等明度上取高饱和的颜色，避免取到纯黑/纯白边缘
        const score = saturation * 2 + value - Math.abs(value - 0.55) * 1.4
        if (score > best.score) best = { score, r, g, b }
      }
    }
    if (best.score < 0) return null
    const hex = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`
  } catch {
    return null
  }
}
