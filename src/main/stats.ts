import type { BookStat, DayStat, StatsPayload } from '../shared/types'
import { todayKey, type Store } from './store'

/** 聚合统计 / 阅读日历 / 阅读历史所需数据 */
export function computeStats(store: Store): StatsPayload {
  const books = store.books.filter((b) => !b.hidden)
  const progress = store.progress

  // 已读完 = 用户手动标记过（finished.json，会跟着局域网同步）+ 进度自然读满的
  const finishedCount = books.filter(
    (b) => Boolean(store.finished[b.id]) || (progress[b.id]?.percent ?? 0) >= 0.99
  ).length
  const totalSeconds = store.sessions.reduce((sum, s) => sum + s.seconds, 0)
  const readBookIds = new Set(store.sessions.map((s) => s.bookId))
  const averageSeconds = readBookIds.size > 0 ? Math.round(totalSeconds / readBookIds.size) : 0

  const dayMap = new Map<string, DayStat>()
  for (const s of store.sessions) {
    const row = dayMap.get(s.day) ?? { day: s.day, seconds: 0, bookIds: [] }
    row.seconds += s.seconds
    if (!row.bookIds.includes(s.bookId)) row.bookIds.push(s.bookId)
    dayMap.set(s.day, row)
  }

  const bookMap = new Map<string, BookStat>()
  for (const s of store.sessions) {
    const row =
      bookMap.get(s.bookId) ??
      ({ bookId: s.bookId, seconds: 0, lastAt: 0, percent: progress[s.bookId]?.percent ?? 0 } satisfies BookStat)
    row.seconds += s.seconds
    row.lastAt = Math.max(row.lastAt, s.lastAt)
    bookMap.set(s.bookId, row)
  }
  for (const [id, row] of bookMap) row.percent = progress[id]?.percent ?? 0

  const today = todayKey()
  const todayRows = store.sessions.filter((s) => s.day === today)
  const todaySeconds = todayRows.reduce((sum, s) => sum + s.seconds, 0)
  const latestToday = todayRows.length > 0 ? todayRows.reduce((a, b) => (a.lastAt >= b.lastAt ? a : b)) : null
  const todayBookId = latestToday?.bookId ?? null

  const percent = todayBookId ? (progress[todayBookId]?.percent ?? 0) : 0
  const secondsOnBook = todayBookId ? (bookMap.get(todayBookId)?.seconds ?? 0) : 0
  const todayRemainingSeconds =
    percent > 0.02 && secondsOnBook > 120 ? Math.round((secondsOnBook / percent) * (1 - percent)) : null

  return {
    bookCount: books.length,
    finishedCount,
    totalSeconds,
    averageSeconds,
    days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    books: [...bookMap.values()].sort((a, b) => b.lastAt - a.lastAt),
    todaySeconds,
    todayBookId,
    todayRemainingSeconds
  }
}
