/**
 * 划线 / 笔记：数据规则与纯函数（主进程 / 渲染进程共用）。
 *
 * 锚点方案：**按文本节点编号 + 节点内字符偏移**。
 * 正文 HTML 由主进程净化后切词（tokenizeHtml），渲染进程用同一套规则遍历 DOM
 * （见 src/renderer/src/lib/annotation-anchor.ts），两边算出的 (block, offset) 完全一致。
 *
 * 为什么不用「段落序号 + 段内偏移」：段落里可能有 <ruby>/<a>/<span> 等行内标签，
 * 一个段落会被拆成多个文本节点，用节点编号才不会错位。
 *
 * 位置是逻辑坐标（与排版无关），所以改字号、切单栏/双栏、滚动↔翻页都不会漂。
 */

import type { Annotation, AnnotationColor } from './types'

export type { Annotation, AnnotationColor }
export type AnnotationStyle = 'highlight' | 'underline'

/** 五色，顺序与界面上的色块一致 */
export const ANNOTATION_COLORS: AnnotationColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']

/** 颜色的中文名（提示与列表里用） */
export const COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  pink: '粉',
  purple: '紫'
}

/** 原文最长存多少字（用于回退匹配；展示只截前 60 字） */
export const QUOTE_MAX = 160

/** 摘录预览长度 */
export const PREVIEW_MAX = 60

export interface TextToken {
  /** 归一化后的文本（连续空白压成一个空格，行首行尾空白去掉） */
  text: string
  /** 原文起始位置（含被丢掉的前导空白） */
  rawStart: number
  /** 原文结束位置（不含） */
  rawEnd: number
  /**
   * 归一化下标 → 原文下标（相对 rawStart）。
   * 长度是 text.length + 1：map[i] 是第 i 个字符的原文位置，map[text.length] 是结尾位置。
   */
  map: number[]
}

/** 切词结果：一个文本块 = 一个「段落」，块内按文本节点顺序编号 */
export type ChapterTokens = TextToken[][]

/** 文本块标签：与渲染进程遍历 DOM 时的判定集合必须一致 */
export const TEXT_BLOCK_TAGS = new Set([
  'p',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'td',
  'th',
  'dd',
  'dt',
  'div',
  'section',
  'article',
  'aside',
  'figcaption',
  'pre'
])

/** 完全跳过内容（含内部文本）的标签 */
export const SKIP_TAGS = new Set([
  'script',
  'style',
  'head',
  'title',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'embed',
  'audio',
  'video'
])

/** 空元素（没有闭合标签） */
export const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'col'])

/** 行内标签默认不打断文本块 */
const INLINE_TAGS = new Set([
  'a',
  'span',
  'em',
  'strong',
  'i',
  'b',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'ruby',
  'rt',
  'rp',
  'mark',
  'code',
  'q',
  'cite',
  'abbr',
  'time',
  'label',
  'big',
  'tt',
  'font',
  'ins',
  'del',
  'wbr',
  'br',
  'img',
  'picture',
  'source'
])

/** 归一化一段文本：连续空白压成一个空格并去掉首尾空白 */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 归一化并记录「归一化下标 → 原文下标」的映射。
 * 前后被丢掉的空白不会算进 text，但插入标记时必须按原文位置偏移，所以要留着映射。
 */
export function collapseWithMap(text: string): { text: string; map: number[] } {
  const out: string[] = []
  const map: number[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      const start = i
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (out.length > 0 && i < text.length) {
        out.push(' ')
        map.push(start)
      }
      continue
    }
    out.push(text[i])
    map.push(i)
    i += 1
  }
  map.push(text.length)
  return { text: out.join(''), map }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
}

/**
 * 把章节 HTML 切成「文本块 → 文本节点」两级结构。
 * 与渲染进程遍历 DOM 得到的结构一一对应（同样的块标签集合、同样的空白归一化）。
 */
export function tokenizeHtml(html: string): ChapterTokens {
  const tokens: ChapterTokens = []
  /** 打开的块级标签栈，栈顶就是要落的文本块 */
  const stack: string[] = []
  let current: TextToken[] | null = null
  let pendingStart = 0

  const inSkip = (): boolean => stack.some((tag) => SKIP_TAGS.has(tag))
  const blockOf = (): string | null => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (TEXT_BLOCK_TAGS.has(stack[i])) return stack[i]
    }
    return null
  }

  const pushText = (raw: string, start: number): void => {
    if (inSkip() || blockOf() === null) return
    const { text, map } = collapseWithMap(decodeEntities(raw))
    if (!text) return
    if (!current) {
      current = []
      tokens.push(current)
    }
    current.push({ text, map, rawStart: start, rawEnd: start + raw.length })
  }

  const tagRe = /<\/?[A-Za-z][^>]*>/g
  let match: RegExpExecArray | null
  let processed = 0

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index > processed) pushText(html.slice(processed, match.index), processed)
    processed = match.index + match[0].length

    const tag = match[0]
    const name = (/^<\/?\s*([A-Za-z][\w:-]*)/.exec(tag)?.[1] ?? '').toLowerCase()
    if (!name) continue
    const closing = /^<\//.test(tag)

    if (closing) {
      const at = stack.lastIndexOf(name)
      if (at >= 0) {
        const closedBlock = stack.slice(at).some((item) => TEXT_BLOCK_TAGS.has(item))
        stack.length = at
        // 只有收掉「块级」元素才需要切换当前块；收行内标签（<em> 等）不能打断段落，
        // 否则同一段会被切成好几块，与渲染层「一个块级元素 = 一块」对不上
        if (closedBlock) {
          current = blockOf() === null ? null : []
        }
      }
      continue
    }

    if (VOID_TAGS.has(name) || /\/>$/.test(tag)) continue
    if (SKIP_TAGS.has(name)) {
      // 跳过整棵子树：把游标推到对应的结束标签之后
      const closeRe = new RegExp(`</\\s*${name}\\s*>`, 'gi')
      closeRe.lastIndex = processed
      const close = closeRe.exec(html)
      if (close) {
        processed = close.index + close[0].length
        tagRe.lastIndex = processed
      }
      continue
    }

    if (TEXT_BLOCK_TAGS.has(name) && !INLINE_TAGS.has(name)) {
      // 进入新的文本块
      stack.push(name)
      current = null
      continue
    }
    stack.push(name)
  }

  if (processed < html.length) pushText(html.slice(processed), processed)
  return tokens
}

/** 某个块能容纳的文本节点数 */
export function tokenCount(tokens: ChapterTokens, blockIndex: number): number {
  return tokens[blockIndex]?.length ?? 0
}

/** 把 (block, offset) 夹到合法范围内 */
export function clampAnchor(
  tokens: ChapterTokens,
  blockIndex: number,
  offset: number
): { blockIndex: number; offset: number } | null {
  const block = tokens[blockIndex]
  if (!block || block.length === 0) return null
  return { blockIndex, offset: Math.min(Math.max(0, offset), block[0].text.length) }
}

/** 原文清洗：压平空白、限长 */
export function normalizeQuote(raw: string): string {
  const text = collapse(String(raw ?? ''))
  return text.length > QUOTE_MAX ? text.slice(0, QUOTE_MAX) : text
}

/** 列表 / 提示里显示的短引文 */
export function quotePreview(quote: string): string {
  const text = collapse(quote)
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text
}

/** 去掉空白，用于模糊匹配（对比时不看换行差异） */
export function squash(text: string): string {
  return String(text ?? '').replace(/\s+/g, '')
}

/**
 * 在切词结果里定位一段原文。
 * 主进程渲染标记时用：锚点失效（换过排版、书被改过）就靠原文重新找回位置。
 * 返回文本块 / 文本节点 / 节点内偏移（含终点字符），找不到返回 null。
 */
export function locateQuote(
  tokens: ChapterTokens,
  quote: string,
  near?: { blockIndex: number; offset: number }
): { blockIndex: number; tokenIndex: number; start: number; endTokenIndex: number; end: number } | null {
  const needle = squash(quote)
  if (needle.length < 2) return null

  // 全部文本节点拼成一个字符串，同时记录每个字符属于哪个节点
  const owner: Array<{ blockIndex: number; tokenIndex: number }> = []
  const chars: string[] = []
  tokens.forEach((block, blockIndex) => {
    block.forEach((token, tokenIndex) => {
      for (const ch of token.text) {
        chars.push(ch)
        owner.push({ blockIndex, tokenIndex })
      }
    })
  })
  const text = chars.join('')
  if (!text) return null
  const squashed = squash(text)

  // squash 后的下标 → 原串下标（折叠掉的空白要还原）
  const mapBack: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (!/\s/.test(text[i])) mapBack.push(i)
  }

  // 就近定位：同一段文字在章内重复出现时，取离锚点最近的那一处（而不是第一处）
  const at = (() => {
    if (!near) return 0
    let count = 0
    for (let b = 0; b <= near.blockIndex && b < tokens.length; b += 1) {
      for (const token of tokens[b]) count += squash(token.text).length
    }
    return Math.max(0, Math.min(squashed.length, count - near.offset))
  })()

  let hit = -1
  let best = Number.POSITIVE_INFINITY
  let cursor = squashed.indexOf(needle)
  while (cursor >= 0) {
    const distance = Math.abs(cursor - at)
    if (distance < best) {
      best = distance
      hit = cursor
    }
    cursor = squashed.indexOf(needle, cursor + 1)
  }
  if (hit < 0) return null

  const head = mapBack[hit]
  const tail = mapBack[Math.min(mapBack.length - 1, hit + needle.length - 1)]
  if (head === undefined || tail === undefined) return null
  const headOwner = owner[head]
  const tailOwner = owner[tail]
  if (!headOwner || !tailOwner) return null

  const offsetIn = (pos: number, at: { blockIndex: number; tokenIndex: number }): number => {
    let base = 0
    for (let b = 0; b < at.blockIndex; b += 1) for (const token of tokens[b]) base += token.text.length
    for (let t = 0; t < at.tokenIndex; t += 1) base += tokens[at.blockIndex][t].text.length
    return pos - base
  }

  return {
    blockIndex: headOwner.blockIndex,
    tokenIndex: headOwner.tokenIndex,
    start: offsetIn(head, headOwner),
    endTokenIndex: tailOwner.tokenIndex,
    end: offsetIn(tail, tailOwner) + 1
  }
}

/* ---------------- 重叠处理 ---------------- */

/** 一条标注在某一章里的位置（起点 + 终点，终点偏移含末字符） */
export interface AnnotationRangeLike {
  id: string
  blockIndex: number
  tokenIndex: number
  startOffset: number
  endBlockIndex: number
  endTokenIndex: number
  endOffset: number
}

/** 在某一块里的一段字符区间：[from, to)，块内偏移 */
interface BlockSpan {
  block: number
  from: number
  to: number
}

/** 按块累计各文本节点的长度，用来把 (节点, 偏移) 折算成块内字符位置 */
function blockBases(tokens: TextToken[][]): number[][] {
  return tokens.map((block) => {
    const bases: number[] = []
    let base = 0
    for (const token of block) {
      bases.push(base)
      base += token.text.length
    }
    return bases
  })
}

function toSpan(
  tokens: TextToken[][],
  bases: number[][],
  blockIndex: number,
  tokenIndex: number,
  offset: number
): { block: number; at: number } | null {
  const block = tokens[blockIndex]
  if (!block) return null
  const token = block[tokenIndex] ?? block[block.length - 1]
  if (!token) return null
  const base = bases[blockIndex][Math.min(tokenIndex, block.length - 1)] ?? 0
  return { block: blockIndex, at: base + Math.min(Math.max(0, offset), token.text.length) }
}

/** 把一条标注折算成若干块内区间 */
export function rangeSpans(tokens: TextToken[][], item: AnnotationRangeLike): BlockSpan[] {
  const bases = blockBases(tokens)
  const start = toSpan(tokens, bases, item.blockIndex, item.tokenIndex, item.startOffset)
  const end = toSpan(tokens, bases, item.endBlockIndex, item.endTokenIndex, item.endOffset)
  if (!start || !end) return []
  const from = { block: Math.min(start.block, end.block), at: start.block <= end.block ? start.at : end.at }
  const to = { block: Math.max(start.block, end.block), at: start.block <= end.block ? end.at : start.at }
  const spans: BlockSpan[] = []
  for (let b = from.block; b <= to.block; b += 1) {
    const block = tokens[b]
    if (!block) continue
    const length = block.reduce((sum, token) => sum + token.text.length, 0)
    const spanFrom = b === from.block ? from.at : 0
    const spanTo = b === to.block ? to.at : length
    if (spanTo > spanFrom) spans.push({ block: b, from: spanFrom, to: spanTo })
  }
  return spans
}

function overlap(a: BlockSpan, b: BlockSpan): boolean {
  return a.block === b.block && Math.min(a.to, b.to) > Math.max(a.from, b.from)
}

/** 两个区间集合是否有交叠 */
export function spansOverlap(left: BlockSpan[], right: BlockSpan[]): boolean {
  return left.some((a) => right.some((b) => overlap(a, b)))
}

/** 从 keep 里减掉 cut，返回剩下的部分 */
function subtract(keep: BlockSpan[], cut: BlockSpan[]): BlockSpan[] {
  let rest = keep
  for (const piece of cut) {
    const next: BlockSpan[] = []
    for (const span of rest) {
      if (span.block !== piece.block || !overlap(span, piece)) {
        next.push(span)
        continue
      }
      if (piece.from > span.from) next.push({ block: span.block, from: span.from, to: piece.from })
      if (piece.to < span.to) next.push({ block: span.block, from: piece.to, to: span.to })
    }
    rest = next
    if (rest.length === 0) break
  }
  return rest
}

interface SpanAnchor {
  tokenIndex: number
  offset: number
  endTokenIndex: number
  endOffset: number
}

/** 把块内区间还原成「文本节点 / 节点内偏移」（起止都在这一个块里） */
function spanToAnchor(tokens: TextToken[][], span: BlockSpan): SpanAnchor | null {
  const block = tokens[span.block]
  if (!block) return null
  const locate = (position: number): { tokenIndex: number; offset: number } => {
    let base = 0
    for (let i = 0; i < block.length; i += 1) {
      const length = block[i].text.length
      if (position <= base + length) return { tokenIndex: i, offset: position - base }
      base += length
    }
    const last = block.length - 1
    return { tokenIndex: last, offset: block[last].text.length }
  }
  const start = locate(span.from)
  const end = locate(span.to)
  return {
    tokenIndex: start.tokenIndex,
    offset: start.offset,
    endTokenIndex: end.tokenIndex,
    endOffset: end.offset
  }
}

export interface AnnotationPlan {
  /** 完全被新选区盖住，直接删掉 */
  remove: string[]
  /** 只被盖住一部分，需要改成剩下的那部分 */
  trim: Array<{
    id: string
    blockIndex: number
    tokenIndex: number
    startOffset: number
    endBlockIndex: number
    endTokenIndex: number
    endOffset: number
    quote: string
  }>
}

/**
 * 新选区与已有标注的重叠处理：
 * - 完全被盖住的旧标注 → 删掉
 * - 只被盖住一部分 → 裁成剩下的几段（每段单独留一条记录）
 * - 完全没碰到的 → 不动
 *
 * 用户要的语义：选中的地方已经划过线，就把它去掉（再按新颜色划一次）；
 * 只有一部分划过，则整段按新颜色划。
 */
export function planForSelection(
  tokens: TextToken[][],
  target: AnnotationRangeLike,
  existing: AnnotationRangeLike[]
): AnnotationPlan {
  const targetSpans = rangeSpans(tokens, target)
  const plan: AnnotationPlan = { remove: [], trim: [] }
  if (targetSpans.length === 0) return plan

  for (const item of existing) {
    if (item.id === target.id) continue
    const spans = rangeSpans(tokens, item)
    if (spans.length === 0 || !spansOverlap(spans, targetSpans)) continue
    const rest = subtract(spans, targetSpans)
    if (rest.length === 0) {
      plan.remove.push(item.id)
      continue
    }
    for (const span of rest) {
      const anchor = spanToAnchor(tokens, span)
      if (!anchor) continue
      const text = tokens[span.block].map((token) => token.text).join('')
      plan.trim.push({
        id: item.id,
        blockIndex: span.block,
        tokenIndex: anchor.tokenIndex,
        startOffset: anchor.offset,
        endBlockIndex: span.block,
        endTokenIndex: anchor.endTokenIndex,
        endOffset: anchor.endOffset,
        quote: text.slice(span.from, span.to)
      })
    }
  }
  return plan
}
export function markHtml(annotation: Annotation, inner: string): string {
  const cls = [
    'ann',
    `ann-${annotation.color}`,
    annotation.style === 'underline' ? 'ann-underline' : 'ann-highlight',
    annotation.note ? 'ann-has-note' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return `<mark class="${cls}" data-ann="${annotation.id}">${inner}</mark>`
}

/** HTML 转义（还原被标记的原文时用） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
