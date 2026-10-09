/**
 * 书签：主进程侧的业务逻辑（增删改查 + 上限 + 墓碑清理）。
 *
 * 只是对 store.bookmarks 数组的一层包装，读写都直接落在这个数组上，
 * 由 Store 负责节流 + 原子写盘。
 */

import { randomUUID } from 'node:crypto'
import type { Bookmark } from '../shared/types'
import {
  BOOKMARK_LIMIT,
  SAME_POSITION_TOLERANCE,
  activeBookmarks,
  findBookmarkAt,
  isPrunableTombstone,
  normalizeExcerpt,
  normalizeNote,
  remainingBookmarkSlots,
  sortBookmarks,
  type BookmarkInput,
  type BookmarkSort
} from '../shared/bookmarks'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export class BookmarkStore {
  /** 直接引用 store.bookmarks 数组（与 progress / sessions 同一套写法） */
  constructor(private readonly items: Bookmark[]) {}

  /** 全部书签，按时间或章节排序 */
  list(sort: BookmarkSort = 'recent', bookId?: string): Bookmark[] {
    const active = activeBookmarks(this.items).filter((item) => !bookId || item.bookId === bookId)
    return sortBookmarks(active, sort)
  }

  /** 某本书还能加几条（墓碑也占额度） */
  remaining(bookId: string): number {
    return remainingBookmarkSlots(this.items, bookId)
  }

  /**
   * 彻底删掉超出撤销窗口的墓碑（释放额度与磁盘）。
   * 加书签 / 撤销删除之前调用：否则「删满 99 条再加」会被自己的墓碑挡住。
   */
  pruneTombstones(now = Date.now()): number {
    let removed = 0
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (isPrunableTombstone(this.items[i], now)) {
        this.items.splice(i, 1)
        removed += 1
      }
    }
    return removed
  }

  /**
   * 新增书签。已到上限、或该位置已经有书签时返回 null
   * （同一位置重复点由渲染进程先判成「编辑已有那条」，这里只兜底）。
   */
  add(input: BookmarkInput, deviceId: string): Bookmark | null {
    this.pruneTombstones()
    if (remainingBookmarkSlots(this.items, input.bookId) <= 0) return null
    if (findBookmarkAt(this.items, input.bookId, input)) return null

    const now = Date.now()
    const item: Bookmark = {
      id: randomUUID(),
      bookId: input.bookId,
      chapterIndex: Math.max(0, Math.round(input.chapterIndex)),
      chapterTitle: String(input.chapterTitle ?? '').slice(0, 120),
      scrollRatio: clamp01(input.scrollRatio),
      percent: clamp01(input.percent),
      excerpt: normalizeExcerpt(input.excerpt),
      note: '',
      createdAt: now,
      updatedAt: now,
      deviceId
    }
    this.items.push(item)
    return { ...item }
  }

  /** 改备注 / 改位置 */
  update(
    id: string,
    patch: { note?: string; scrollRatio?: number; percent?: number; excerpt?: string }
  ): Bookmark | null {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.deletedAt) return null
    if (patch.note !== undefined) item.note = normalizeNote(patch.note)
    if (patch.scrollRatio !== undefined) item.scrollRatio = clamp01(patch.scrollRatio)
    if (patch.percent !== undefined) item.percent = clamp01(patch.percent)
    if (patch.excerpt !== undefined) item.excerpt = normalizeExcerpt(patch.excerpt)
    item.updatedAt = Date.now()
    return { ...item }
  }

  /** 软删除（写墓碑），撤销要留得住 */
  remove(id: string): Bookmark | null {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || item.deletedAt) return null
    item.deletedAt = Date.now()
    item.updatedAt = item.deletedAt
    return { ...item }
  }

  /**
   * 撤销删除。
   * 判定额度时要先把自己排除掉 —— 满 99 条时删一条再撤销，
   * 占用的正是它自己让出来的那个额度，不能因为「已满」而拒绝。
   */
  restore(id: string): Bookmark | null {
    const item = this.items.find((entry) => entry.id === id)
    if (!item || !item.deletedAt) return null
    this.pruneTombstones()
    // 墓碑本身可能刚好被清掉（超过撤销窗口），这时就当恢复失败
    if (!this.items.includes(item)) return null
    const others = this.items.filter((entry) => entry !== item)
    if (remainingBookmarkSlots(others, item.bookId) <= 0) return null
    delete item.deletedAt
    item.updatedAt = Date.now()
    return { ...item }
  }

  /** 某本书被删除 / 移出书库时，连带清掉它的书签 */
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

  /** 启动时清理过期墓碑、修正越界数据、去重、裁剪超出上限的历史数据 */
  sweep(now = Date.now()): boolean {
    let changed = false

    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i]
      if (isPrunableTombstone(item, now)) {
        this.items.splice(i, 1)
        changed = true
        continue
      }
      const ratio = clamp01(item.scrollRatio)
      if (ratio !== item.scrollRatio) {
        item.scrollRatio = ratio
        changed = true
      }
      const percent = clamp01(item.percent)
      if (percent !== item.percent) {
        item.percent = percent
        changed = true
      }
      if (typeof item.note !== 'string') {
        item.note = ''
        changed = true
      }
      if (typeof item.excerpt !== 'string') {
        item.excerpt = ''
        changed = true
      }
    }

    // 同一位置只保留最新的一条（历史数据或将来同步回来的可能重复）
    const kept: Bookmark[] = []
    for (const item of [...this.items].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const dup = item.deletedAt
        ? undefined
        : kept.find(
            (other) =>
              !other.deletedAt &&
              other.bookId === item.bookId &&
              other.chapterIndex === item.chapterIndex &&
              Math.abs(other.scrollRatio - item.scrollRatio) <= SAME_POSITION_TOLERANCE
          )
      if (dup) {
        this.items.splice(this.items.indexOf(item), 1)
        changed = true
        continue
      }
      kept.push(item)
    }

    // 超出一本书上限的历史数据：删掉最早的几条
    const byBook = new Map<string, Bookmark[]>()
    for (const item of activeBookmarks(this.items)) {
      const bucket = byBook.get(item.bookId)
      if (bucket) bucket.push(item)
      else byBook.set(item.bookId, [item])
    }
    for (const bucket of byBook.values()) {
      if (bucket.length <= BOOKMARK_LIMIT) continue
      const doomed = [...bucket].sort((a, b) => a.createdAt - b.createdAt).slice(0, bucket.length - BOOKMARK_LIMIT)
      for (const item of doomed) {
        this.items.splice(this.items.indexOf(item), 1)
        changed = true
      }
    }

    return changed
  }
}
