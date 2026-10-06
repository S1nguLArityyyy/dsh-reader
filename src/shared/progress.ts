/** 阅读进度计算：主进程与渲染进程共用同一套规则 */

/**
 * 整书进度：已读完章节的字数 + 当前章节字数 × 章内位置，再除以全书字数。
 * 这样进度反映的是「读到了全书的哪个位置」，而不是「读到第几章」。
 */
export function percentByPosition(
  chapterChars: number[] | undefined,
  wordCount: number,
  chapterIndex: number,
  scrollRatio: number
): number {
  const chars = chapterChars ?? []
  const total = wordCount > 0 ? wordCount : chars.reduce((sum, n) => sum + n, 0)
  if (chars.length === 0 || total <= 0) return 0
  let before = 0
  for (let i = 0; i < chapterIndex && i < chars.length; i += 1) before += chars[i]
  const current = chars[Math.min(Math.max(0, chapterIndex), chars.length - 1)] ?? 0
  return Math.min(1, Math.max(0, (before + current * scrollRatio) / total))
}

/** 章内进度（0~1），就是当前章节里的阅读位置 */
export function chapterPercent(scrollRatio: number): number {
  return Math.min(1, Math.max(0, scrollRatio))
}
