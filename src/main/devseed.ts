import type { Book, SessionRow } from '../shared/types'
import { readChapter, readEpubMeta } from './epub'
import { ensureExtracted } from './library'
import { toMediaUrl } from './media'
import { todayKey, type Store } from './store'

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 仅开发 / 截图验收用的书签种子数据（由 DSH_SEED_BOOKMARKS=1 触发）。
 * 摘录取真正文，方便核对列表里的显示效果。
 */
export async function seedDemoBookmarks(store: Store): Promise<void> {
  if (store.books.length === 0) return
  const now = Date.now()
  let total = 0

  for (const [bookIndex, book] of store.books.slice(0, 5).entries()) {
    try {
      const meta = await readEpubMeta(book.filePath)
      const cacheDir = await ensureExtracted(store, book)
      const wanted = Math.min(meta.chapterHrefs.length, 2 + (bookIndex % 3))
      for (let i = 0; i < wanted; i += 1) {
        const chapterIndex = Math.min(i, Math.max(0, meta.chapterHrefs.length - 1))
        const chapter = await readChapter(cacheDir, meta.opfDir, meta.chapterHrefs[chapterIndex], toMediaUrl)
        const text = stripTags(chapter.html)
        if (text.length < 20) continue
        // 每本书的第 2 条书签往后挪一点，看起来像不同页
        const scrollRatio = i === 0 ? 0.12 : Math.min(0.9, 0.25 + i * 0.22)
        const created = store.bookmarkStore.add(
          {
            bookId: book.id,
            chapterIndex,
            chapterTitle: `第 ${chapterIndex + 1} 章`,
            scrollRatio,
            percent: scrollRatio * 0.6,
            excerpt: text.slice(i * 40, i * 40 + 60)
          },
          store.settings.deviceId
        )
        if (!created) continue
        total += 1
        if (i === 1) {
          store.bookmarkStore.update(created.id, { note: '这一段写得真好，回头再看一遍' })
        }
        // 时间拉开：越后面的书签越早，且保证「最近添加」里第一条最新
        created.createdAt = now - (bookIndex * 3 + i) * 26 * 3600 * 1000
        created.updatedAt = created.createdAt
      }
    } catch (err) {
      console.error(`[seed] 书签种子失败（${book.title}）`, err)
    }
  }

  store.save('bookmarks', true)
  console.log(`[seed] 已写入 ${total} 条书签`)
}

/**
 * 仅开发 / 截图验收用的统计种子数据（由 DSH_SEED_STATS=1 触发）。
 * 正式运行时不会执行，也不会伪造任何同步进度。
 */
export function seedDemoStats(store: Store): void {
  if (store.books.length === 0) return
  const now = new Date()
  const sessions: SessionRow[] = []

  store.books.forEach((book: Book, bookIndex: number) => {
    const activeDays = bookIndex === 0 ? 14 : bookIndex === 1 ? 8 : 5
    for (let d = 0; d < activeDays; d += 1) {
      const date = new Date(now)
      date.setDate(now.getDate() - Math.round(d * (bookIndex + 1.6)))
      const day = todayKey(date)
      const minutes = 6 + ((d * 7 + bookIndex * 5) % 26)
      const start = new Date(date)
      start.setHours(20, 10, 0, 0)
      sessions.push({
        id: `seed-${bookIndex}-${d}`,
        bookId: book.id,
        day,
        seconds: minutes * 60,
        firstAt: start.getTime(),
        lastAt: start.getTime() + minutes * 60 * 1000
      })
    }
  })

  const today = todayKey()
  if (!sessions.some((s) => s.day === today) && store.books[0]) {
    const start = Date.now() - 1000 * 60 * 30
    sessions.push({
      id: 'seed-today',
      bookId: store.books[0].id,
      day: today,
      seconds: 30 * 60,
      firstAt: start,
      lastAt: Date.now()
    })
  }

  store.sessions = sessions
  store.books.forEach((book, index) => {
    const percent = index === 0 ? 0.35 : index === 1 ? 1 : 0.09
    store.progress[book.id] = {
      bookId: book.id,
      percent,
      chapterIndex: percent >= 1 ? 3 : Math.floor(percent * 4),
      chapterTitle: percent >= 1 ? '第四章 归航' : '第一章 潮汐线',
      scrollRatio: 0.3,
      updatedAt: Date.now() - index * 3600_000,
      deviceId: store.settings.deviceId,
      rev: 3 + index
    }
    const latest = sessions.filter((s) => s.bookId === book.id).sort((a, b) => b.lastAt - a.lastAt)[0]
    book.lastOpenedAt = latest ? latest.lastAt : book.addedAt
  })

  store.save('sessions', true)
  store.save('progress', true)
  store.save('library', true)
  console.log(`[seed] 已写入 ${sessions.length} 条阅读会话`)
}
