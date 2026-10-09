/**
 * 书签：数据规则与纯函数（主进程 / 渲染进程共用）
 *
 * 定位规则：`chapterIndex` + `scrollRatio` 是主键，摘录只用于展示与「跳回来是不是这一页」的校验。
 * 不写字内字符偏移 —— 所以改字号、切单栏双栏、滚动↔翻页都不会让书签漂移。
 */

import type { Bookmark } from './types'

export type { Bookmark }

/** 新增书签时由渲染进程提供的字段（id / 时间 / 设备由主进程补） */
export interface BookmarkInput {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  scrollRatio: number
  /** 整书进度；主进程会按书籍字数重算一遍，这里只是兜底 */
  percent: number
  excerpt: string
}

/** 每本书的书签上限 */
export const BOOKMARK_LIMIT = 99

/** 摘录最长字数 */
export const EXCERPT_MAX = 60

/** 备注最长字数 */
export const NOTE_MAX = 300

/** 同一位置判定：同一章内、滚动比例相差不超过这个值，视为同一条书签 */
export const SAME_POSITION_TOLERANCE = 0.02

/** 墓碑保留天数，超过则清理 */
export const TOMBSTONE_DAYS = 30

/**
 * 撤销窗口（毫秒）。
 * 界面上的「撤销」只出现几秒；超过这个时间的墓碑不再占用书签额度，
 * 于是「删一条 → 再加一条」永远加得回来，文件也不会被墓碑撑大。
 */
export const UNDO_WINDOW_MS = 10 * 60 * 1000

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 摘录清洗：合并空白、去掉开头的孤立标点、截断到 EXCERPT_MAX */
export function normalizeExcerpt(raw: string): string {
  let text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  // 选到段首时容易带出上一个标点，去掉句首的孤立标点
  text = text.replace(/^[，。！？；：、"'"''）】》…—\-.]+/, '')
  text = text.trim()
  return text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) : text
}

/** 备注清理：去首尾空白 + 限长 */
export function normalizeNote(raw: string): string {
  const text = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  return text.length > NOTE_MAX ? text.slice(0, NOTE_MAX) : text
}

/** 未删除的书签 */
export function activeBookmarks(list: Bookmark[]): Bookmark[] {
  return list.filter((item) => !item.deletedAt)
}

/** 某本书里未删除的书签 */
export function bookmarksOf(list: Bookmark[], bookId: string): Bookmark[] {
  return activeBookmarks(list).filter((item) => item.bookId === bookId)
}

/** 该书未删除的书签数 */
export function bookmarkCount(list: Bookmark[], bookId: string): number {
  return bookmarksOf(list, bookId).length
}

/**
 * 该书还能加几条书签。
 * 撤销窗口内的墓碑仍然占额度（否则反复「加满→删光→再加」会让 json 无限增长），
 * 但过了撤销窗口的墓碑不再占额度，删掉的那条位置可以立刻补回来。
 */
export function remainingBookmarkSlots(list: Bookmark[], bookId: string, now = Date.now()): number {
  const used = list.filter(
    (item) =>
      item.bookId === bookId &&
      (!item.deletedAt || now - item.deletedAt <= UNDO_WINDOW_MS)
  ).length
  return Math.max(0, BOOKMARK_LIMIT - used)
}

/** 是否该把这条墓碑彻底删掉（释放额度与磁盘） */
export function isPrunableTombstone(item: Bookmark, now = Date.now()): boolean {
  if (!item.deletedAt) return false
  return isExpiredTombstone(item, now) || now - item.deletedAt > UNDO_WINDOW_MS
}

/** 两个位置是否算同一处 */
export function isSamePosition(
  a: Pick<Bookmark, 'chapterIndex' | 'scrollRatio'>,
  b: Pick<Bookmark, 'chapterIndex' | 'scrollRatio'>
): boolean {
  if (a.chapterIndex !== b.chapterIndex) return false
  return Math.abs(clamp01(a.scrollRatio) - clamp01(b.scrollRatio)) <= SAME_POSITION_TOLERANCE
}

/** 找出该位置上已有的书签（用于「点击是新增还是编辑」） */
export function findBookmarkAt(
  list: Bookmark[],
  bookId: string,
  position: Pick<Bookmark, 'chapterIndex' | 'scrollRatio'>
): Bookmark | null {
  return bookmarksOf(list, bookId).find((item) => isSamePosition(item, position)) ?? null
}

export type BookmarkSort = 'recent' | 'chapter'

/** 排序：recent = 最近添加在前；chapter = 章内位置升序 */
export function sortBookmarks(list: Bookmark[], sort: BookmarkSort): Bookmark[] {
  const copy = [...list]
  if (sort === 'chapter') {
    copy.sort((a, b) => a.chapterIndex - b.chapterIndex || a.scrollRatio - b.scrollRatio)
  } else {
    copy.sort((a, b) => b.createdAt - a.createdAt)
  }
  return copy
}

/** 按书分组，返回「有书签的书 id → 书签（已排序）」 */
export function groupByBook(list: Bookmark[], sort: BookmarkSort = 'recent'): Map<string, Bookmark[]> {
  const map = new Map<string, Bookmark[]>()
  for (const item of activeBookmarks(list)) {
    const bucket = map.get(item.bookId)
    if (bucket) bucket.push(item)
    else map.set(item.bookId, [item])
  }
  for (const [key, bucket] of map) map.set(key, sortBookmarks(bucket, sort))
  return map
}

/** 每本书最近一条书签的时间（左栏按它倒序排） */
export function lastBookmarkAt(list: Bookmark[], bookId: string): number {
  let last = 0
  for (const item of activeBookmarks(list)) {
    if (item.bookId !== bookId) continue
    if (item.createdAt > last) last = item.createdAt
  }
  return last
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 书签时间显示：今天 14:20 / 昨天 22:03 / 10月7日 */
export function bookmarkTimeText(ts: number, now = Date.now()): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const dayMs = 86400000
  if (ts >= startOfToday) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (ts >= startOfToday - dayMs) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 墓碑是否已过期（启动时清理用） */
export function isExpiredTombstone(item: Bookmark, now = Date.now()): boolean {
  if (!item.deletedAt) return false
  return now - item.deletedAt > TOMBSTONE_DAYS * 86400000
}

/** 超出撤销窗口、可以彻底删掉的墓碑（每次加书签前清理一次） */
export function prunableTombstones(list: Bookmark[], now = Date.now()): Bookmark[] {
  return list.filter((item) => isPrunableTombstone(item, now))
}
