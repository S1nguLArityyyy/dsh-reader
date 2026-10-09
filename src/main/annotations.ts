/**
 * 划线 / 笔记：主进程侧的注入与仓储。
 *
 * 章节正文由 readChapter 净化后，这里按标记切词（tokenizeHtml）并把每条标注包成 <mark>，
 * 再把结果发给渲染进程 —— 渲染进程不需要自己插标记，
 * 所以分页、换字号、单双栏、目录跳转都自动带上标记。
 *
 * 注入的做法：块内所有文本节点拼成一个字符串（与渲染进程看到的完全一致），
 * 在拼接串上按字符位置切分，再把每段映射回「原始 HTML 的绝对偏移」，
 * 从后往前插入开/合标签，原有标签与属性一个字节都不动。
 */

import { randomUUID } from 'node:crypto'
import type {
  Annotation,
  AnnotationColor,
  AnnotationInput,
  AnnotationPatch,
  AnnotationStyle
} from '../shared/types'
import {
  collapse,
  locateQuote,
  normalizeQuote,
  tokenizeHtml,
  type ChapterTokens,
  type TextToken
} from '../shared/annotations'

/** 备注最长字数 */
export const NOTE_MAX = 500

/** 每本书的标注上限 */
export const ANNOTATION_LIMIT = 999

/** 撤销窗口：这段时间内的墓碑仍占额度，超过后彻底清理 */
export const ANNOTATION_UNDO_MS = 10 * 60 * 1000

const COLOR_SET = new Set<AnnotationColor>(['yellow', 'green', 'blue', 'pink', 'purple'])

function clampNote(raw: string): string {
  const text = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  return text.length > NOTE_MAX ? text.slice(0, NOTE_MAX) : text
}

function clampInt(value: number, min = 0): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.round(value))
}

/* ---------------- 查询辅助 ---------------- */

export function activeAnnotations(list: Annotation[]): Annotation[] {
  return list.filter((item) => !item.deletedAt)
}

export function annotationsOfChapter(list: Annotation[], bookId: string, chapterIndex: number): Annotation[] {
  return activeAnnotations(list).filter((item) => item.bookId === bookId && item.chapterIndex === chapterIndex)
}

export function annotationCount(list: Annotation[], bookId: string): number {
  return activeAnnotations(list).filter((item) => item.bookId === bookId).length
}

export function annotationCountsByChapter(list: Annotation[], bookId: string): Map<number, number> {
  const map = new Map<number, number>()
  for (const item of activeAnnotations(list)) {
    if (item.bookId !== bookId) continue
    map.set(item.chapterIndex, (map.get(item.chapterIndex) ?? 0) + 1)
  }
  return map
}

/* ---------------- 锚点定位 ---------------- */

export interface ResolvedRange {
  startBlock: number
  startToken: number
  start: number
  endBlock: number
  endToken: number
  end: number
}

/** 块内字符位置 → (文本节点, 节点内偏移) */
function findTokenAt(block: TextToken[], position: number): { tokenIndex: number; offset: number } | null {
  if (block.length === 0) return null
  let base = 0
  for (let i = 0; i < block.length; i += 1) {
    const length = block[i].text.length
    if (position < base + length) return { tokenIndex: i, offset: position - base }
    base += length
  }
  const last = block.length - 1
  return { tokenIndex: last, offset: block[last].text.length }
}

/** 判断锚点范围里的原文是否与记录的 quote 吻合 */
function quoteMatches(tokens: ChapterTokens, range: ResolvedRange, quote: string): boolean {
  const want = collapse(quote).replace(/\s+/g, '')
  if (want.length < 2) return true
  const parts: string[] = []
  for (let b = range.startBlock; b <= range.endBlock; b += 1) {
    const block = tokens[b]
    if (!block) continue
    const first = b === range.startBlock ? range.startToken : 0
    const last = b === range.endBlock ? range.endToken : block.length - 1
    for (let t = first; t <= last; t += 1) {
      const token = block[t]
      if (!token) continue
      const from = b === range.startBlock && t === range.startToken ? range.start : 0
      const to = b === range.endBlock && t === range.endToken ? range.end : token.text.length
      parts.push(token.text.slice(from, to))
    }
  }
  const got = parts.join('').replace(/\s+/g, '')
  return got === want || want.startsWith(got) || got.startsWith(want)
}

function directRange(tokens: ChapterTokens, item: Annotation): ResolvedRange | null {
  const startBlock = tokens[item.blockIndex]
  const endBlock = tokens[item.endBlockIndex]
  if (!startBlock || !endBlock) return null
  const startToken = startBlock[item.tokenIndex]
  const endToken = endBlock[item.endTokenIndex]
  if (!startToken || !endToken) return null
  return {
    startBlock: item.blockIndex,
    startToken: item.tokenIndex,
    start: Math.min(Math.max(0, item.startOffset), startToken.text.length),
    endBlock: item.endBlockIndex,
    endToken: item.endTokenIndex,
    end: Math.min(Math.max(0, item.endOffset), endToken.text.length)
  }
}

/**
 * 把标注解析成范围：先信锚点，锚点对不上原文时用 quote 在全章重新找。
 * 返回 null 表示这条标注确实定位不到（调用方应标记为「失效」而不是硬画在错误的位置）。
 *
 * 跨节点时会把范围归一化：块内偏移算成「首节点内起点 → 末节点内终点」。
 * 渲染层给的是 (startToken, startOffset) 与 (endToken, endOffset)，
 * 但 endOffset 的语义是「末字符之后」——跨节点时两个锚点可能落在同一个字符间隙上，
 * 归一化后才是真正的 [from, to) 区间。
 */
export function resolveRange(tokens: ChapterTokens, item: Annotation): ResolvedRange | null {
  const direct = directRange(tokens, item)
  if (!direct) return fromQuote(tokens, item)
  if (quoteMatches(tokens, direct, item.quote)) return normalizeRange(tokens, direct)
  return fromQuote(tokens, item) ?? normalizeRange(tokens, direct)
}

/** 跨节点归一化：只保留真正被覆盖的字符区间（逐字符判定，避免起止锚点语义不一致） */
function normalizeRange(tokens: ChapterTokens, range: ResolvedRange): ResolvedRange | null {
  const startBlock = range.startBlock
  const startToken = range.startToken
  const endBlock = range.endBlock
  const endToken = range.endToken
  if (startBlock === endBlock && startToken === endToken) return range

  const covered: Array<{ block: number; token: number; offset: number }> = []
  for (let b = startBlock; b <= endBlock; b += 1) {
    const block = tokens[b]
    if (!block) continue
    // 逐节点算出本条标注在该节点里覆盖的 [from, to)
    for (let t = 0; t < block.length; t += 1) {
      const length = block[t].text.length
      let from = 0
      let to = length
      if (b === startBlock && t < startToken) continue
      if (b === endBlock && t > endToken) break
      if (b === startBlock && t === startToken) from = Math.max(0, range.start)
      if (b === endBlock && t === endToken) to = Math.min(length, Math.max(0, range.end))
      for (let o = from; o < to; o += 1) covered.push({ block: b, token: t, offset: o })
    }
  }
  if (covered.length === 0) return null
  const head = covered[0]
  const tail = covered[covered.length - 1]
  return {
    startBlock: head.block,
    startToken: head.token,
    start: head.offset,
    endBlock: tail.block,
    endToken: tail.token,
    end: tail.offset + 1
  }
}

function fromQuote(tokens: ChapterTokens, item: Annotation): ResolvedRange | null {
  const found = locateQuote(tokens, item.quote, { blockIndex: item.blockIndex, offset: item.startOffset })
  if (!found) return null
  return {
    startBlock: found.blockIndex,
    startToken: found.tokenIndex,
    start: found.start,
    endBlock: found.blockIndex,
    endToken: found.endTokenIndex,
    end: found.end
  }
}

/* ---------------- 注入标记 ---------------- */

interface Piece {
  /** 原始 HTML 的绝对插入位置 */
  at: number
  text: string
}

/** 归一化偏移 → 原文偏移（用切词时记下的映射，含被折叠掉的空白） */
function rawOffsetOf(token: TextToken, normalizedOffset: number): number {
  const map = token.map
  if (!map || map.length === 0) return 0
  const index = Math.min(Math.max(0, normalizedOffset), map.length - 1)
  return map[index]
}

function markOpen(item: Annotation): string {
  const cls = [
    'ann',
    `ann-${item.color}`,
    item.style === 'underline' ? 'ann-underline' : 'ann-highlight'
  ].join(' ')
  return `<mark class="${cls}" data-ann="${item.id}"${item.note ? ' data-note="1"' : ''}>`
}

/**
 * 把标注包成 <mark> 注入章节 HTML。
 *
 * 做法：块内所有文本节点拼成一个字符串，在拼接串上按 [from, to) 切分，
 * 再把两个端点映射回原始 HTML 的绝对偏移，从后往前插入开 / 合标签 ——
 * 原有标签、属性、实体一个字节都不动。
 */
export function applyAnnotations(
  html: string,
  annotations: Annotation[],
  onResolved?: (id: string, resolved: boolean) => void
): string {
  if (annotations.length === 0) return html
  const tokens = tokenizeHtml(html)
  const pieces: Piece[] = []

  /** 块内拼接串上的位置 → 原文绝对偏移 */
  const positionOf = (block: TextToken[], position: number): number => {
    let base = 0
    for (const token of block) {
      const length = token.text.length
      // 落在本节点内（含正好落在本节点末尾）
      if (position <= base + length) return token.rawStart + rawOffsetOf(token, position - base)
      base += length
    }
    const tail = block[block.length - 1]
    return tail ? tail.rawStart + (tail.rawEnd - tail.rawStart) : 0
  }

  for (const item of annotations) {
    const range = resolveRange(tokens, item)
    if (!range) continue

    const blockFrom = Math.min(range.startBlock, range.endBlock)
    const blockTo = Math.max(range.startBlock, range.endBlock)
    for (let b = blockFrom; b <= blockTo; b += 1) {
      const block = tokens[b]
      if (!block) continue
      const total = block.reduce((sum, token) => sum + token.text.length, 0)
      if (total === 0) continue

      const from = b === range.startBlock ? Math.min(Math.max(0, range.start), total) : 0
      const to = b === range.endBlock ? Math.min(Math.max(0, range.end), total) : total
      if (to <= from) continue

      pieces.push({ at: positionOf(block, from), text: markOpen(item) })
      pieces.push({ at: positionOf(block, to), text: '</mark>' })
    }
  }

  // 从后往前插入，前面的位置才不会被后来的插入挤偏
  pieces.sort((a, b) => b.at - a.at)
  let out = html
  for (const piece of pieces) {
    out = `${out.slice(0, piece.at)}${piece.text}${out.slice(piece.at)}`
  }
  return out
}

/* ---------------- 仓储 ---------------- */

export class AnnotationStore {
  /** 直接引用 store.annotations 数组（与 progress / bookmarks 同一套写法） */
  constructor(private readonly items: Annotation[]) {}

  list(bookId?: string, chapterIndex?: number): Annotation[] {
    return activeAnnotations(this.items)
      .filter((item) => (bookId ? item.bookId === bookId : true))
      .filter((item) => (chapterIndex === undefined ? true : item.chapterIndex === chapterIndex))
      .sort(
        (a, b) =>
          a.chapterIndex - b.chapterIndex || a.blockIndex - b.blockIndex || a.startOffset - b.startOffset
      )
  }

  /** 还能加几条（撤销窗口内的墓碑也占额度） */
  remaining(bookId: string): number {
    const used = this.items.filter(
      (item) => item.bookId === bookId && (!item.deletedAt || Date.now() - item.deletedAt <= ANNOTATION_UNDO_MS)
    ).length
    return Math.max(0, ANNOTATION_LIMIT - used)
  }

  add(input: AnnotationInput, deviceId: string): Annotation | null {
    this.pruneTombstones()
    if (this.remaining(input.bookId) <= 0) return null
    const now = Date.now()
    const item: Annotation = {
      id: randomUUID(),
      bookId: input.bookId,
      chapterIndex: clampInt(input.chapterIndex),
      chapterTitle: String(input.chapterTitle ?? '').slice(0, 120),
      blockIndex: clampInt(input.blockIndex),
      tokenIndex: clampInt(input.tokenIndex),
      startOffset: clampInt(input.startOffset),
      endBlockIndex: clampInt(input.endBlockIndex),
      endTokenIndex: clampInt(input.endTokenIndex),
      endOffset: clampInt(input.endOffset),
      quote: normalizeQuote(input.quote),
      note: clampNote(input.note ?? ''),
      color: COLOR_SET.has(input.color) ? input.color : 'yellow',
      style: input.style === 'underline' ? 'underline' : 'highlight',
      createdAt: now,
      updatedAt: now,
      deviceId
    }
    if (!item.quote) return null
    this.items.push(item)
    return { ...item }
  }

  /** 改颜色 / 改样式 / 改备注；也可以改位置（重叠裁切时用） */
  update(id: string, patch: AnnotationPatch): Annotation | null {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.deletedAt) return null
    if (patch.color && COLOR_SET.has(patch.color)) item.color = patch.color
    if (patch.style) item.style = patch.style === 'underline' ? 'underline' : 'highlight'
    if (patch.note !== undefined) item.note = clampNote(patch.note)
    if (patch.blockIndex !== undefined) item.blockIndex = clampInt(patch.blockIndex)
    if (patch.tokenIndex !== undefined) item.tokenIndex = clampInt(patch.tokenIndex)
    if (patch.startOffset !== undefined) item.startOffset = clampInt(patch.startOffset)
    if (patch.endBlockIndex !== undefined) item.endBlockIndex = clampInt(patch.endBlockIndex)
    if (patch.endTokenIndex !== undefined) item.endTokenIndex = clampInt(patch.endTokenIndex)
    if (patch.endOffset !== undefined) item.endOffset = clampInt(patch.endOffset)
    if (patch.quote !== undefined) {
      const quote = normalizeQuote(patch.quote)
      if (quote) item.quote = quote
    }
    item.updatedAt = Date.now()
    return { ...item }
  }

  remove(id: string): Annotation | null {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.deletedAt) return null
    item.deletedAt = Date.now()
    item.updatedAt = item.deletedAt
    return { ...item }
  }

  restore(id: string): Annotation | null {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || !item.deletedAt) return null
    this.pruneTombstones()
    if (!this.items.includes(item)) return null
    delete item.deletedAt
    item.updatedAt = Date.now()
    return { ...item }
  }

  removeByBook(bookId: string): number {
    let removed = 0
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].bookId === bookId) {
        this.items.splice(i, 1)
        removed += 1
      }
    }
    return removed
  }

  pruneTombstones(now = Date.now()): number {
    let removed = 0
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i]
      if (item.deletedAt && now - item.deletedAt > ANNOTATION_UNDO_MS) {
        this.items.splice(i, 1)
        removed += 1
      }
    }
    return removed
  }

  /** 启动清理：过期墓碑、字段缺失或没有原文的坏记录 */
  sweep(now = Date.now()): boolean {
    let changed = false
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i]
      const stale = item.deletedAt !== undefined && now - item.deletedAt > 30 * 86400000
      if (stale || typeof item.quote !== 'string' || item.quote.length === 0) {
        this.items.splice(i, 1)
        changed = true
        continue
      }
      if (typeof item.note !== 'string') {
        item.note = ''
        changed = true
      }
      if (!COLOR_SET.has(item.color)) {
        item.color = 'yellow'
        changed = true
      }
      if (item.style !== 'highlight' && item.style !== 'underline') {
        item.style = 'highlight'
        changed = true
      }
    }
    return changed
  }
}
