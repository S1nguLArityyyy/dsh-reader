import type { Book } from '@shared/types'

export interface BookGroup {
  key: string
  title: string
  books: Book[]
}

export const SINGLES_KEY = '__singles__'

export function sortBooks(books: Book[], sort: 'recent' | 'added' | 'title'): Book[] {
  const list = [...books]
  if (sort === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  if (sort === 'added') return list.sort((a, b) => b.addedAt - a.addedAt)
  return list.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt))
}

/** 同系列（>=2 本）单独分组，其余归入「单册书籍」 */
export function groupBooks(books: Book[]): BookGroup[] {
  const counts = new Map<string, number>()
  for (const book of books) {
    if (book.seriesKey) counts.set(book.seriesKey, (counts.get(book.seriesKey) ?? 0) + 1)
  }

  const series = new Map<string, Book[]>()
  const singles: Book[] = []
  for (const book of books) {
    const key = book.seriesKey
    if (key && (counts.get(key) ?? 0) > 1) {
      const list = series.get(key) ?? []
      list.push(book)
      series.set(key, list)
    } else {
      singles.push(book)
    }
  }

  const groups: BookGroup[] = [...series.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([key, list]) => ({
      key,
      title: key,
      // 系列内部按卷号升序，未标卷号的排在最后
      books: [...list].sort((a, b) => {
        const av = a.volume ? Number(a.volume) : Number.MAX_SAFE_INTEGER
        const bv = b.volume ? Number(b.volume) : Number.MAX_SAFE_INTEGER
        if (av !== bv) return av - bv
        return a.title.localeCompare(b.title, 'zh-Hans-CN')
      })
    }))

  if (singles.length > 0) groups.push({ key: SINGLES_KEY, title: '单册书籍', books: singles })
  return groups
}
