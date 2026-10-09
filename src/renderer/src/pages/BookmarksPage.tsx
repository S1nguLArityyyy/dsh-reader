import { useEffect, useMemo } from 'react'
import { Bookmark as BookmarkIcon, ChevronDown, Clock, ListOrdered, MapPin, Trash2 } from 'lucide-react'
import { activeBookmarks, bookmarkTimeText, lastBookmarkAt, sortBookmarks } from '@shared/bookmarks'
import type { Bookmark } from '@shared/types'
import { useApp } from '../store/app'
import { BookCover } from '../components/BookCover'
import { Dropdown, EmptyState } from '../components/ui'
import { percentText } from '../lib/format'

/** 左栏一行：一本书 + 它的书签概况 */
interface BookEntry {
  bookId: string
  title: string
  author: string
  count: number
  lastAt: number
  percent: number
}

/**
 * 书签页面：左 1/3 是有书签的书，右 2/3 是选中那本书的书签卡片流。
 * 右栏必须先在左栏选书（没有「全部书签」视图）。
 */
export function BookmarksPage() {
  const books = useApp((s) => s.books)
  const bookmarks = useApp((s) => s.bookmarks)
  const selectedBookId = useApp((s) => s.bookmarkBookId)
  const sort = useApp((s) => s.bookmarkSort)
  const setBook = useApp((s) => s.setBookmarkBook)
  const setSort = useApp((s) => s.setBookmarkSort)
  const loadBookmarks = useApp((s) => s.loadBookmarks)
  const removeBookmark = useApp((s) => s.removeBookmark)
  const openReader = useApp((s) => s.openReader)
  const go = useApp((s) => s.go)
  const loadBooks = useApp((s) => s.loadBooks)

  useEffect(() => {
    void loadBookmarks()
    void loadBooks()
  }, [loadBookmarks, loadBooks])

  // 左栏：只列有书签的书，按最近一条书签的时间倒序
  const entries = useMemo<BookEntry[]>(() => {
    const active = activeBookmarks(bookmarks)
    const byBook = new Map<string, Bookmark[]>()
    for (const item of active) {
      const bucket = byBook.get(item.bookId)
      if (bucket) bucket.push(item)
      else byBook.set(item.bookId, [item])
    }
    const list: BookEntry[] = []
    for (const [bookId, items] of byBook) {
      const book = books.find((b) => b.id === bookId)
      list.push({
        bookId,
        title: book?.title ?? '（书籍已移出书库）',
        author: book?.author ?? '',
        count: items.length,
        lastAt: lastBookmarkAt(items, bookId),
        percent: items.reduce((max, item) => Math.max(max, item.percent), 0)
      })
    }
    return list.sort((a, b) => b.lastAt - a.lastAt)
  }, [bookmarks, books])

  // 选中的书被删掉 / 书签被清空时，自动落到第一本
  useEffect(() => {
    if (entries.length === 0) {
      if (selectedBookId !== null) setBook(null)
      return
    }
    if (!selectedBookId || !entries.some((entry) => entry.bookId === selectedBookId)) {
      setBook(entries[0].bookId)
    }
  }, [entries, selectedBookId, setBook])

  const selected = entries.find((entry) => entry.bookId === selectedBookId) ?? null
  const items = useMemo(
    () => (selected ? sortBookmarks(bookmarks.filter((item) => item.bookId === selected.bookId), sort) : []),
    [bookmarks, selected, sort]
  )
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)


  const jump = (item: Bookmark): void => {
    void openReader(item.bookId, {
      chapterIndex: item.chapterIndex,
      scrollRatio: item.scrollRatio,
      excerpt: item.excerpt
    })
  }

  if (entries.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h1 className="page-title">书签</h1>
        </div>
        <EmptyState
          icon={<BookmarkIcon size={26} />}
          title="还没有书签"
          desc="阅读时点顶栏的 🔖 书签按钮，就能记住当前这一页"
          action={
            <button className="btn btn-primary btn-sm" onClick={() => go('library')}>
              去书库挑一本
            </button>
          }
        />
      </div>
    )
  }

  return (
    <div className="bm-page">
      <div className="bm-head">
        <h1 className="page-title">书签</h1>
        <span className="bm-head-count">
          共 {entries.length} 本 · {total} 条
        </span>
      </div>

      <div className="bm-split">
        {/* 左栏：有书签的书 */}
        <aside className="bm-books">
          <div className="bm-books-list">
            {entries.map((entry) => (
              <button
                key={entry.bookId}
                className={`bm-book${entry.bookId === selectedBookId ? ' active' : ''}`}
                onClick={() => setBook(entry.bookId)}
                title={entry.title}
              >
                <div className="bm-book-cover">
                  {(() => {
                    const target = books.find((b) => b.id === entry.bookId)
                    return target ? <BookCover book={target} /> : <div className="bm-book-cover-empty" />
                  })()}
                </div>
                <div className="bm-book-main">
                  <div className="bm-book-title">{entry.title}</div>
                  {entry.author ? <div className="bm-book-author">{entry.author}</div> : null}
                  <div className="bm-book-meta">
                    <span>{entry.count} 条书签</span>
                    <span>最近 {bookmarkTimeText(entry.lastAt)}</span>
                  </div>
                  <div className="bm-book-progress">
                    <i style={{ width: `${percentText(entry.percent)}%` }} />
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="bm-books-foot">
            共 {entries.length} 本 · {total} 条
          </div>
        </aside>

        {/* 右栏：选中书的书签卡片流 */}
        <section className="bm-detail">
          <div className="bm-detail-head">
            <div className="bm-detail-title">
              {selected ? selected.title : '未选择书籍'}
              {selected ? <span className="bm-detail-count"> · {selected.count} 条</span> : null}
            </div>
            <Dropdown
              trigger={
                <button className="btn btn-ghost btn-sm">
                  {sort === 'recent' ? '最近添加' : '按章节'}
                  <ChevronDown size={14} />
                </button>
              }
            >
              {(close) => (
                <>
                  <button
                    onClick={() => {
                      setSort('recent')
                      close()
                    }}
                  >
                    <Clock size={14} />
                    最近添加
                  </button>
                  <button
                    onClick={() => {
                      setSort('chapter')
                      close()
                    }}
                  >
                    <ListOrdered size={14} />
                    按章节
                  </button>
                </>
              )}
            </Dropdown>
          </div>

          <div className="bm-list">
            {!selected ? (
              <EmptyState icon={<BookmarkIcon size={26} />} title="从左侧选一本书" desc="选中后这里显示它的书签" />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<BookmarkIcon size={26} />}
                title="这本书还没有书签"
                desc="阅读时点顶栏的 🔖 书签按钮即可添加"
              />
            ) : (
              items.map((item) => (
                <div
                  className="bm-card"
                  key={item.id}
                  onClick={() => jump(item)}
                  title="点击回到这个位置"
                >
                  <div className="bm-card-excerpt">{item.excerpt || '（没有摘录）'}</div>
                  <div className="bm-card-meta">
                    <span className="bm-card-chapter">{item.chapterTitle || `第 ${item.chapterIndex + 1} 章`}</span>
                    <span>·</span>
                    <span>{percentText(item.scrollRatio)}%</span>
                    <span>·</span>
                    <span>{bookmarkTimeText(item.createdAt)}</span>
                  </div>
                  {item.note ? <div className="bm-card-note">{item.note}</div> : null}
                  <div className="bm-card-actions">
                    <button
                      className="icon-btn sm"
                      title="回到这个位置"
                      onClick={(e) => {
                        e.stopPropagation()
                        jump(item)
                      }}
                    >
                      <MapPin size={15} />
                    </button>
                    <button
                      className="icon-btn sm danger"
                      title="删除书签"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeBookmark(item.id)
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
