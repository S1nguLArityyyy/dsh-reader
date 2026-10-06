import type { Book, SessionRow } from '../shared/types'
import { todayKey, type Store } from './store'

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
