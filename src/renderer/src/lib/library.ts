import type { Book } from '@shared/types'
import { looseKey } from '@shared/naming'

export interface BookGroup {
  key: string
  title: string
  books: Book[]
  /** 用户手动指定的合集 */
  manual?: boolean
  /** 由模糊匹配得到的分组（标题里没有卷号） */
  fuzzy?: boolean
}

export const SINGLES_KEY = '__singles__'
export const MANUAL_PREFIX = 'manual:'

export function sortBooks(books: Book[], sort: 'recent' | 'added' | 'title'): Book[] {
  const list = [...books]
  if (sort === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  if (sort === 'added') return list.sort((a, b) => b.addedAt - a.addedAt)
  return list.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt))
}

/** 组内排序：按卷号升序，没有卷号的排在最后 */
function byVolume(a: Book, b: Book): number {
  const av = a.volume ? Number(a.volume) : Number.MAX_SAFE_INTEGER
  const bv = b.volume ? Number(b.volume) : Number.MAX_SAFE_INTEGER
  if (av !== bv) return av - bv
  return a.title.localeCompare(b.title, 'zh-Hans-CN')
}

/**
 * 书架分组，优先级从高到低：
 *   1. 用户手动指定的合集
 *   2. 从书名解析出的系列（同系列 >= 2 本）
 *   3. 模糊归组：标题去掉数字与标点后互为前缀的（解决「文件名里没有卷号」的情况）
 *   4. 其余进「单册书籍」
 */
export function groupBooks(books: Book[]): BookGroup[] {
  const groups = new Map<string, BookGroup>()
  const push = (key: string, title: string, book: Book, flags: Partial<BookGroup> = {}): void => {
    const group = groups.get(key) ?? { key, title, books: [], ...flags }
    group.books.push(book)
    groups.set(key, group)
  }

  const singles: Book[] = []
  const rest: Book[] = []

  // 1) 手动合集
  for (const book of books) {
    const manual = book.manualSeries?.trim()
    if (manual) push(`${MANUAL_PREFIX}${manual}`, manual, book, { manual: true })
    else rest.push(book)
  }

  // 2) 解析出的系列
  const bySeries = new Map<string, Book[]>()
  const noSeries: Book[] = []
  for (const book of rest) {
    if (book.seriesKey) {
      const list = bySeries.get(book.seriesKey) ?? []
      list.push(book)
      bySeries.set(book.seriesKey, list)
    } else {
      noSeries.push(book)
    }
  }
  for (const [key, list] of bySeries) {
    if (list.length >= 2) {
      for (const book of list) push(`series:${key}`, key, book)
    } else {
      noSeries.push(...list)
    }
  }

  // 3) 模糊归组
  const clusters: { key: string; books: Book[] }[] = []
  for (const book of noSeries) {
    const key = looseKey(book.title)
    if (key.length < 3) {
      singles.push(book)
      continue
    }
    const hit = clusters.find((c) => c.key.startsWith(key) || key.startsWith(c.key))
    if (hit) {
      hit.books.push(book)
      if (key.length < hit.key.length) hit.key = key
    } else {
      clusters.push({ key, books: [book] })
    }
  }
  for (const cluster of clusters) {
    if (cluster.books.length >= 2) {
      for (const book of cluster.books) push(`fuzzy:${cluster.key}`, cluster.key, book, { fuzzy: true })
    } else {
      singles.push(cluster.books[0])
    }
  }

  const result = [...groups.values()]
  for (const group of result) group.books.sort(byVolume)
  result.sort((a, b) => {
    if (Boolean(a.manual) !== Boolean(b.manual)) return a.manual ? -1 : 1
    return b.books.length - a.books.length || a.title.localeCompare(b.title, 'zh-Hans-CN')
  })

  if (singles.length > 0) {
    result.push({ key: SINGLES_KEY, title: '单册书籍', books: singles.sort(byVolume) })
  }
  return result
}

/** 书库里出现过的所有合集名（手动 + 自动），用于「归入合集」的候选 */
export function allSeriesNames(books: Book[]): string[] {
  const names = new Set<string>()
  for (const book of books) {
    if (book.manualSeries?.trim()) names.add(book.manualSeries.trim())
    if (book.seriesKey) names.add(book.seriesKey)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}
