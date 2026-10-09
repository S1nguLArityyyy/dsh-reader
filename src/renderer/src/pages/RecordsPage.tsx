import { useEffect, useMemo } from 'react'
import { Bookmark as BookmarkIcon, Highlighter, NotebookPen, Trash2 } from 'lucide-react'
import { quotePreview } from '@shared/annotations'
import type { Annotation } from '@shared/types'
import { useApp } from '../store/app'
import { BookCover } from '../components/BookCover'
import { EmptyState, SegmentedControl } from '../components/ui'
import { bookmarkTimeText } from '@shared/bookmarks'

/** 左栏一行：一本书 + 它的划线/笔记概况 */
interface BookEntry {
  bookId: string
  title: string
  author: string
  highlights: number
  notes: number
  total: number
  lastAt: number
}

type Filter = 'all' | 'highlight' | 'note'

/**
 * 阅读记录页：左 1/3 是有划线/笔记的书，右 2/3 是选中那本书的标注卡片流。
 * 布局与书签页一致，只是卡片内容是「原文引文 + 颜色/样式 + 备注」。
 */
export function RecordsPage() {
  const books = useApp((s) => s.books)
  const annotations = useApp((s) => s.annotations)
  const selectedBookId = useApp((s) => s.recordBookId)
  const filter = useApp((s) => s.recordFilter)
  const setRecordBook = useApp((s) => s.setRecordBook)
  const setRecordFilter = useApp((s) => s.setRecordFilter)
  const loadAnnotations = useApp((s) => s.loadAnnotations)
  const loadBooks = useApp((s) => s.loadBooks)
  const removeAnnotation = useApp((s) => s.removeAnnotation)
  const openAnnotation = useApp((s) => s.openAnnotation)
  const go = useApp((s) => s.go)

  useEffect(() => {
    void loadAnnotations()
    void loadBooks()
  }, [loadAnnotations, loadBooks])

  // 左栏：只列有划线/笔记的书，按最近一条的时间倒序
  const entries = useMemo<BookEntry[]>(() => {
    const byBook = new Map<string, Annotation[]>()
    for (const item of annotations) {
      if (item.deletedAt) continue
      const bucket = byBook.get(item.bookId)
      if (bucket) bucket.push(item)
      else byBook.set(item.bookId, [item])
    }
    const list: BookEntry[] = []
    for (const [bookId, items] of byBook) {
      const book = books.find((b) => b.id === bookId)
      const notes = items.filter((item) => item.note).length
      list.push({
        bookId,
        title: book?.title ?? '（书籍已移出书库）',
        author: book?.author ?? '',
        notes,
        highlights: items.length - notes,
        total: items.length,
        lastAt: items.reduce((max, item) => Math.max(max, item.createdAt), 0)
      })
    }
    return list.sort((a, b) => b.lastAt - a.lastAt)
  }, [annotations, books])

  // 选中的书被删 / 记录被清空时自动落到第一本
  useEffect(() => {
    if (entries.length === 0) {
      if (selectedBookId !== null) setRecordBook(null)
      return
    }
    if (!selectedBookId || !entries.some((entry) => entry.bookId === selectedBookId)) {
      setRecordBook(entries[0].bookId)
    }
  }, [entries, selectedBookId, setRecordBook])

  const selected = entries.find((entry) => entry.bookId === selectedBookId) ?? null
  const items = useMemo(() => {
    if (!selected) return []
    return annotations
      .filter((item) => item.bookId === selected.bookId && !item.deletedAt)
      .filter((item) => (filter === 'highlight' ? !item.note : filter === 'note' ? Boolean(item.note) : true))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [annotations, selected, filter])

  const total = entries.reduce((sum, entry) => sum + entry.total, 0)

  if (entries.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h1 className="page-title">阅读记录</h1>
        </div>
        <EmptyState
          icon={<Highlighter size={26} />}
          title="还没有划线或笔记"
          desc="阅读时选中一段文字，就会在文字上方弹出菜单：可以划线、也可以加笔记"
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
        <h1 className="page-title">阅读记录</h1>
        <span className="bm-head-count">
          共 {entries.length} 本 · {total} 条
        </span>
      </div>

      <div className="bm-split">
        {/* 左栏：有划线/笔记的书 */}
        <aside className="bm-books">
          <div className="bm-books-list">
            {entries.map((entry) => (
              <button
                key={entry.bookId}
                className={`bm-book${entry.bookId === selectedBookId ? ' active' : ''}`}
                onClick={() => setRecordBook(entry.bookId)}
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
                    <span>{entry.total} 条</span>
                    <span>最近 {bookmarkTimeText(entry.lastAt)}</span>
                  </div>
                  <div className="bm-book-tags">
                    {entry.highlights > 0 ? <span className="rec-tag">划线 {entry.highlights}</span> : null}
                    {entry.notes > 0 ? <span className="rec-tag note">笔记 {entry.notes}</span> : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="bm-books-foot">
            共 {entries.length} 本 · {total} 条
          </div>
        </aside>

        {/* 右栏：选中书的划线 / 笔记卡片流 */}
        <section className="bm-detail">
          <div className="bm-detail-head">
            <div className="bm-detail-title">
              {selected ? selected.title : '未选择书籍'}
              {selected ? <span className="bm-detail-count"> · {selected.total} 条</span> : null}
            </div>
            <SegmentedControl<Filter>
              size="sm"
              variant="soft"
              value={filter}
              onChange={setRecordFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'highlight', label: '划线' },
                { value: 'note', label: '笔记' }
              ]}
            />
          </div>

          <div className="bm-list">
            {!selected ? (
              <EmptyState icon={<Highlighter size={26} />} title="从左侧选一本书" desc="选中后这里显示它的划线与笔记" />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<NotebookPen size={26} />}
                title={filter === 'note' ? '这本书还没有笔记' : '这本书还没有划线'}
                desc="阅读时选中文字即可划线或写笔记"
              />
            ) : (
              items.map((item) => (
                <div className="bm-card rec-card" key={item.id} onClick={() => void openAnnotation(item)} title="点击回到这段文字">
                  <div className={`rec-quote ann-${item.color}${item.style === 'underline' ? ' underline' : ''}`}>
                    {quotePreview(item.quote)}
                  </div>
                  <div className="bm-card-meta">
                    <span className="bm-card-chapter">{item.chapterTitle || `第 ${item.chapterIndex + 1} 章`}</span>
                    <span>·</span>
                    <span>{item.style === 'underline' ? '下划线' : '高亮'}</span>
                    <span>·</span>
                    <span>{bookmarkTimeText(item.createdAt)}</span>
                  </div>
                  {item.note ? <div className="bm-card-note">{item.note}</div> : null}
                  <div className="bm-card-actions">
                    <button
                      className="icon-btn sm"
                      title="回到这段文字"
                      onClick={(e) => {
                        e.stopPropagation()
                        void openAnnotation(item)
                      }}
                    >
                      <BookmarkIcon size={15} />
                    </button>
                    <button
                      className="icon-btn sm danger"
                      title="删除这条记录"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeAnnotation(item.id)
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
