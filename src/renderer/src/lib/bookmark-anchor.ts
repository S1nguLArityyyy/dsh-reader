/**
 * 阅读器里的位置换算与摘录提取。
 *
 * 「当前位置」= 章内滚动比例；翻页模式取当前屏对应的比例，
 * 这样无论滚动还是翻页，书签都落在同一个位置上。
 */

/** 摘录只取到 60 字（与 shared/bookmarks.ts 的 EXCERPT_MAX 一致） */
const EXCERPT_MAX = 60

/** 章内滚动比例 0~1 */
export function scrollRatioOf(body: HTMLElement | null): number {
  if (!body) return 0
  const max = body.scrollHeight - body.clientHeight
  if (max <= 8) return 0
  return Math.min(1, Math.max(0, body.scrollTop / max))
}

/** 把滚动比例还原成滚动位置 */
export function applyScrollRatio(body: HTMLElement | null, ratio: number): void {
  if (!body) return
  const max = body.scrollHeight - body.clientHeight
  if (max <= 0) return
  body.scrollTop = max * Math.min(1, Math.max(0, ratio))
}

/** 翻页模式：当前屏在整章中的位置比例 */
export function pagedRatio(page: number, pages: number): number {
  if (pages <= 1) return 0
  return Math.min(1, Math.max(0, page / pages))
}

/** 正文容器里的块级元素（阅读位置与摘录都落在这些块上） */
export function contentBlocks(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  const page = root.querySelector('.reader-page')
  if (!page) return []
  return Array.from(page.querySelectorAll<HTMLElement>('p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd')).filter(
    (el) => Boolean(el.textContent && el.textContent.trim())
  )
}

/**
 * 视口顶部那个位置，落在哪一段里（取最后一段「顶边还没越过视口顶部」的块）。
 * 依赖的 top 是元素顶边、与视口无关，所以不会随视口高度抖动，
 * 段落之间的外边距也不会让前一段「赖着不走」。
 */
export function topVisibleBlock(root: HTMLElement | null, scrollTop: number): HTMLElement | null {
  if (!root) return null
  const blocks = contentBlocks(root)
  let hit: HTMLElement | null = null
  for (const el of blocks) {
    if (el.getBoundingClientRect().top <= scrollTop + 1) hit = el
    else break
  }
  return hit ?? (blocks.length > 0 ? blocks[0] : null)
}

function cleanExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > EXCERPT_MAX ? compact.slice(0, EXCERPT_MAX) : compact
}

/**
 * 当前页面的原文摘录。
 * 滚动模式取视口顶部第一段（与 scrollHeight 比例一致，校验位置也用它）；
 * 翻页模式下整章被切成横向多栏，DOM 里量不出「当前屏」是哪一段，取章首第一段（稳定、可预期）。
 */
export function currentExcerpt(body: HTMLElement | null, mode: 'scroll' | 'paged'): string {
  if (!body) return ''
  if (mode === 'paged') {
    const first = contentBlocks(body)[0]
    return cleanExcerpt(first?.textContent ?? '')
  }
  const block = topVisibleBlock(body, body.scrollTop)
  return cleanExcerpt(block?.textContent ?? '')
}

/** 摘录与当前页是否吻合（跳转后校验，避免「跳回来不是这一页」） */
export function excerptMatches(excerpt: string, current: string): boolean {
  const a = excerpt.replace(/\s+/g, '')
  const b = current.replace(/\s+/g, '')
  if (a.length < 6 || b.length < 6) return true
  const probe = a.slice(0, Math.min(12, a.length))
  return b.includes(probe)
}
