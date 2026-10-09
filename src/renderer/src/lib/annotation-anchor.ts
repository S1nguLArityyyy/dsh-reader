/**
 * 渲染进程侧的标注锚点：把 DOM 选区翻译成「文本块 / 文本节点 / 节点内偏移」。
 *
 * 规则必须与主进程的 tokenizeHtml（src/shared/annotations.ts）完全一致，
 * 否则主进程注入 <mark> 时会画错位置：
 * - 块级元素集合一致（blockElementsIn）
 * - 每块内的文本节点顺序一致（文档顺序，递归进子元素）
 * - 空白归一化一致（连续空白压成一个空格，首尾去掉）
 */

import { SKIP_TAGS, TEXT_BLOCK_TAGS, collapseWithMap } from '@shared/annotations'

export interface DomToken {
  node: Text
  /** 归一化后的文本 */
  text: string
  /** 归一化下标 → 原文下标 */
  map: number[]
}

/** 章内所有文本块，按正文顺序 */
export type DomTokens = DomToken[][]

/** 章节内容容器里的块级元素（与主进程的文本块集合一致） */
export function blockElementsIn(root: Element): Element[] {
  const out: Element[] = []
  const children = root.children
  for (let i = 0; i < children.length; i += 1) {
    const el = children[i]
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) continue
    if (TEXT_BLOCK_TAGS.has(tag)) {
      // 块级元素自己也成一块；里面如果还嵌着块级元素（<div><p>…</p></div>），
      // 那些子块也要各算一块 —— 与主进程切词保持一致
      out.push(el)
      out.push(...blockElementsIn(el))
      continue
    }
    out.push(...blockElementsIn(el))
  }
  return out
}

/**
 * 把一个块级元素里的文本节点按文档顺序收集起来（跳过 script/style/svg）。
 * 遇到嵌套的块级元素就停：那属于它自己那一块，不能重复计入父块
 * （与主进程切词一致）。
 */
function textNodesIn(el: Element, out: Text[] = []): Text[] {
  const walk = (node: Node, isRoot = false): void => {
    if (node.nodeType === 3) {
      out.push(node as Text)
      return
    }
    if (node.nodeType !== 1) return
    const tag = (node as Element).tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) return
    // 子块级元素归它自己，不再往下收
    if (!isRoot && TEXT_BLOCK_TAGS.has(tag)) return
    const children = node.childNodes
    for (let i = 0; i < children.length; i += 1) walk(children[i])
  }
  walk(el, true)
  return out
}

/** 遍历 DOM，得到与主进程切词结果一一对应的结构 */
export function tokenizeDom(root: Element): DomTokens {
  const blocks: DomTokens = []
  for (const el of blockElementsIn(root)) {
    const tokens: DomToken[] = []
    for (const node of textNodesIn(el)) {
      const { text, map } = collapseWithMap(node.nodeValue ?? '')
      if (!text) continue
      tokens.push({ node, text, map })
    }
    if (tokens.length > 0) blocks.push(tokens)
  }
  return blocks
}

/** 文本节点在某块内的序号 */
function indexOfNode(block: DomToken[], node: Node): number {
  return block.findIndex((token) => token.node === node)
}

export interface Anchor {
  blockIndex: number
  tokenIndex: number
  offset: number
}

/** 一条标注的位置：起点 + 终点（终点偏移含末字符） */
export interface AnnotationRange {
  blockIndex: number
  tokenIndex: number
  start?: number
  startOffset?: number
  endBlockIndex?: number
  endTokenIndex?: number
  end?: number
  endOffset?: number
  /** 原文：注入过 <mark> 之后 tokenIndex 会失效，靠它在块内重新定位 */
  quote?: string
}

/** 块内字符位置（跨节点的拼接串）的位置 */
function offsetInBlock(block: DomToken[], tokenIndex: number, normalizedOffset: number): number {
  let base = 0
  for (let i = 0; i < tokenIndex; i += 1) base += block[i].text.length
  return base + normalizedOffset
}

/**
 * 把「块内拼接串位置」翻译成 (节点, 节点内偏移)。
 * 位置正好落在节点边界时归给前一个节点（与主进程的 endOffset 语义一致）。
 */
function locate(block: DomToken[], position: number): { tokenIndex: number; offset: number } | null {
  if (block.length === 0) return null
  if (position <= 0) return { tokenIndex: 0, offset: 0 }
  let base = 0
  for (let i = 0; i < block.length; i += 1) {
    const length = block[i].text.length
    if (position < base + length) return { tokenIndex: i, offset: position - base }
    if (position === base + length) return { tokenIndex: i, offset: length }
    base += length
  }
  const last = block.length - 1
  return { tokenIndex: last, offset: block[last].text.length }
}

/**
 * 判断一个 DOM 节点属于哪个文本块（块内任意文本节点的祖先即可）。
 * 找不到返回 -1：说明选区落在了正文之外（例如图片、脚注链接区）。
 */
function blockIndexOfNode(tokens: DomTokens, node: Node): number {
  for (let b = 0; b < tokens.length; b += 1) {
    for (const token of tokens[b]) {
      if (token.node === node) return b
      if (token.node.parentNode && token.node.parentNode.contains(node)) return b
      if (node.contains(token.node)) return b
    }
  }
  return -1
}

export interface SelectionAnchor {
  blockIndex: number
  tokenIndex: number
  start: number
  endBlockIndex: number
  endTokenIndex: number
  end: number
  quote: string
}

/**
 * 把当前选区翻译成锚点 + 原文。
 * 选区不在正文里（或落到图片/链接上）时返回 null。
 */
export function selectionAnchor(root: Element, selection: Selection | null): SelectionAnchor | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null

  const tokens = tokenizeDom(root)
  if (tokens.length === 0) return null

  const startBlock = blockIndexOfNode(tokens, range.startContainer)
  const endBlock = blockIndexOfNode(tokens, range.endContainer)
  if (startBlock < 0 || endBlock < 0) return null
  if (startBlock > endBlock) return null

  const locatePoint = (
    blockIndex: number,
    container: Node,
    offset: number,
    isStart: boolean
  ): { tokenIndex: number; offset: number } | null => {
    const block = tokens[blockIndex]
    const tokenIndex = indexOfNode(block, container)
    if (tokenIndex >= 0) {
      const token = block[tokenIndex]
      // DOM 偏移 → 归一化偏移：map 是「归一化下标 → 原文下标」
      let normalized = 0
      while (normalized < token.map.length - 1 && token.map[normalized + 1] <= offset) normalized += 1
      return { tokenIndex, offset: normalized }
    }
    // 容器是元素（选区落在 <em>/<a> 这类行内标签上）：落到该元素里的第一个 / 最后一个文本节点
    if (container.nodeType === 1) {
      const target = container as Element
      for (let i = 0; i < block.length; i += 1) {
        if (!target.contains(block[i].node)) continue
        if (isStart) return { tokenIndex: i, offset: 0 }
      }
      for (let i = block.length - 1; i >= 0; i -= 1) {
        if (target.contains(block[i].node)) return { tokenIndex: i, offset: block[i].text.length }
      }
    }
    return null
  }

  const head = locatePoint(startBlock, range.startContainer, range.startOffset, true)
  const tail = locatePoint(endBlock, range.endContainer, range.endOffset, false)
  if (!head || !tail) return null

  const startFlat = offsetInBlock(tokens[startBlock], head.tokenIndex, head.offset)
  const endFlat = offsetInBlock(tokens[endBlock], tail.tokenIndex, tail.offset)
  if (startBlock === endBlock && endFlat <= startFlat) return null

  const flatText = (blockIndex: number): string => tokens[blockIndex].map((token) => token.text).join('')
  const parts: string[] = []
  for (let b = startBlock; b <= endBlock; b += 1) {
    const text = flatText(b)
    const from = b === startBlock ? startFlat : 0
    const to = b === endBlock ? endFlat : text.length
    parts.push(text.slice(from, to))
  }
  const quote = parts.join('')

  // 回到「节点 + 节点内偏移」的规范形式
  const startAt = locate(tokens[startBlock], startFlat)
  const endAt = locate(tokens[endBlock], endFlat)
  if (!startAt || !endAt) return null

  return {
    blockIndex: startBlock,
    tokenIndex: startAt.tokenIndex,
    start: startAt.offset,
    endBlockIndex: endBlock,
    endTokenIndex: endAt.tokenIndex,
    end: endAt.offset,
    quote
  }
}

/**
 * 把锚点还原成 DOM Range（点击已有标记时选中原选区、或滚动定位用）。
 *
 * 注意：正文里注入过 <mark> 之后，文本节点会被切开，存下来的 tokenIndex 已经对不上，
 * 所以优先用 quote 在块内重新定位；找不到才退回按 tokenIndex 硬算。
 */
export function anchorRange(root: Element, anchor: AnnotationRange): Range | null {
  const tokens = tokenizeDom(root)
  const startOffset = anchor.start ?? anchor.startOffset ?? 0
  const endOffset = anchor.end ?? anchor.endOffset ?? 0
  const startBlock = tokens[anchor.blockIndex]
  const endBlock = tokens[anchor.endBlockIndex ?? anchor.blockIndex]
  if (!startBlock || !endBlock) return null

  /** 生成 (节点, 偏移) 并夹到节点长度内 */
  const pointAt = (token: DomToken, normalizedOffset: number): { node: Text; offset: number } => {
    const index = Math.min(Math.max(0, normalizedOffset), token.map.length - 1)
    return { node: token.node, offset: token.map[index] }
  }

  const flatOf = (block: DomToken[]): string => block.map((token) => token.text).join('')
  const inBlock = (block: DomToken[], position: number): { token: DomToken; offset: number } | null => {
    let base = 0
    for (const token of block) {
      const length = token.text.length
      if (position <= base + length) return { token, offset: position - base }
      base += length
    }
    const last = block[block.length - 1]
    return last ? { token: last, offset: last.text.length } : null
  }

  let from: { node: Text; offset: number } | null = null
  let to: { node: Text; offset: number } | null = null

  const quote = (anchor.quote ?? '').replace(/\s+/g, '')
  if (quote.length > 0) {
    const flat = flatOf(startBlock).replace(/\s+/g, '')
    const hit = flat.indexOf(quote)
    if (hit >= 0) {
      // squash 后的下标与原串 1:1（块内文本已经是归一化过的），直接用
      const head = inBlock(startBlock, hit)
      const tail = inBlock(startBlock, hit + quote.length)
      if (head && tail) {
        from = pointAt(head.token, head.offset)
        to = pointAt(tail.token, tail.offset)
      }
    }
  }

  if (!from || !to) {
    const startToken = startBlock[anchor.tokenIndex]
    const endToken = endBlock[anchor.endTokenIndex ?? anchor.tokenIndex]
    if (!startToken || !endToken) return null
    from = pointAt(startToken, startOffset)
    to = pointAt(endToken, endOffset)
  }

  const range = document.createRange()
  try {
    range.setStart(from.node, Math.min(from.offset, from.node.nodeValue?.length ?? 0))
    range.setEnd(to.node, Math.min(to.offset, to.node.nodeValue?.length ?? 0))
  } catch {
    return null
  }
  return range
}
