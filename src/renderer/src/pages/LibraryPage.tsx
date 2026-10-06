import { useMemo } from 'react'
import {
  ArrowRight,
  BookPlus,
  CloudUpload,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Play,
  Trash2,
  Upload
} from 'lucide-react'
import type { Book } from '@shared/types'
import { useApp } from '../store/app'
import { BookCover } from '../components/BookCover'
import { Dropdown, EmptyState, ProgressRing } from '../components/ui'
import { coverFade, percentText, remainingText } from '../lib/format'
import { groupBooks, sortBooks } from '../lib/library'

export function LibraryPage() {
  const books = useApp((s) => s.books)
  const stats = useApp((s) => s.stats)
  const settings = useApp((s) => s.settings)
  const seriesFilter = useApp((s) => s.seriesFilter)
  const setSeriesFilter = useApp((s) => s.setSeriesFilter)
  const importDialog = useApp((s) => s.importDialog)
  const importFolderDialog = useApp((s) => s.importFolderDialog)
  const openReader = useApp((s) => s.openReader)
  const openDetail = useApp((s) => s.openDetail)
  const removeBook = useApp((s) => s.removeBook)
  const updateBook = useApp((s) => s.updateBook)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)

  const percentMap = useMemo(
    () => new Map((stats?.books ?? []).map((item) => [item.bookId, item.percent])),
    [stats]
  )

  const sorted = useMemo(() => sortBooks(books, settings?.librarySort ?? 'recent'), [books, settings])
  const allGroups = useMemo(() => groupBooks(sorted), [sorted])
  const groups = useMemo(
    () => (seriesFilter ? allGroups.filter((g) => g.key === seriesFilter) : allGroups),
    [allGroups, seriesFilter]
  )

  const continueBook = useMemo(() => {
    if (sorted.length === 0) return null
    if (stats?.todayBookId) {
      const hit = sorted.find((b) => b.id === stats.todayBookId)
      if (hit) return hit
    }
    const inProgress = sorted.find((b) => {
      const percent = percentMap.get(b.id) ?? 0
      return percent > 0.001 && percent < 0.999
    })
    return inProgress ?? sorted[0]
  }, [sorted, stats, percentMap])

  const goalMinutes = settings?.dailyGoalMinutes ?? 30
  const todaySeconds = stats?.todaySeconds ?? 0
  const todayMinutes = Math.floor(todaySeconds / 60)
  const goalPercent = goalMinutes > 0 ? Math.min(1, todayMinutes / goalMinutes) : 0
  const remaining = stats?.todayRemainingSeconds ?? null
  const bookPercent = continueBook ? (percentMap.get(continueBook.id) ?? 0) : 0

  const confirmDelete = async (book: Book, deleteFile: boolean): Promise<void> => {
    const ok = await window.api.dialog.confirm({
      title: deleteFile ? '删除书籍' : '移除书籍',
      message: deleteFile ? `确定删除《${book.title}》吗？` : `确定将《${book.title}》移出书库吗？`,
      detail: deleteFile ? '书籍文件与阅读记录都会被删除，此操作不可撤销。' : '仅从书库移除，磁盘上的原文件会保留。',
      confirmText: deleteFile ? '删除' : '移除',
      danger: deleteFile
    })
    if (ok) await removeBook(book.id, deleteFile)
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{seriesFilter ? allGroups.find((g) => g.key === seriesFilter)?.title ?? '本地书库' : '本地书库'}</h1>
        <div className="head-actions">
          {seriesFilter ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setSeriesFilter(null)}>
              显示全部
            </button>
          ) : null}
          <button className="icon-btn" title="导入 EPUB 文件" onClick={() => void importDialog()}>
            <Upload size={20} />
          </button>
          <Dropdown
            trigger={
              <button className="icon-btn" title="更多操作">
                <MoreHorizontal size={20} />
              </button>
            }
          >
            {(close) => (
              <>
                <button
                  onClick={() => {
                    close()
                    void importDialog()
                  }}
                >
                  <BookPlus size={15} />
                  导入 EPUB 文件
                </button>
                <button
                  onClick={() => {
                    close()
                    void importFolderDialog()
                  }}
                >
                  <FolderPlus size={15} />
                  导入文件夹
                </button>
                <hr />
                <button
                  onClick={() => {
                    close()
                    void saveSettings({ librarySort: 'recent' })
                  }}
                >
                  按最近阅读排序
                </button>
                <button
                  onClick={() => {
                    close()
                    void saveSettings({ librarySort: 'added' })
                  }}
                >
                  按导入时间排序
                </button>
                <button
                  onClick={() => {
                    close()
                    void saveSettings({ librarySort: 'title' })
                  }}
                >
                  按书名排序
                </button>
              </>
            )}
          </Dropdown>
        </div>
      </div>

      {books.length === 0 ? (
        <EmptyState
          icon={<BookPlus size={30} />}
          title="书库还是空的"
          desc="拖拽 EPUB 文件到窗口，或点击下面的按钮导入"
          action={
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={() => void importDialog()}>
                <Upload size={15} />
                导入 EPUB
              </button>
              <button className="btn btn-ghost" onClick={() => void importFolderDialog()}>
                <FolderOpen size={15} />
                导入文件夹
              </button>
            </div>
          }
        />
      ) : (
        <>
          {!seriesFilter ? (
            <div
              className="card today-card"
              style={{ background: coverFade(continueBook?.coverColor ?? null, continueBook?.id ?? 'empty') }}
            >
              <div className="today-cover">
                {continueBook ? <BookCover book={continueBook} /> : null}
              </div>

              <div className="today-info">
                <div className="today-label">今日阅读</div>
                <div className="today-book" title={continueBook?.title}>
                  {continueBook?.title ?? '还没有书籍'}
                </div>
                <div className="today-author">
                  {continueBook?.author ?? '导入一本 EPUB 开始阅读'}
                </div>
                <div className="today-actions">
                  <button
                    className="btn today-btn"
                    disabled={!continueBook}
                    onClick={() => continueBook && void openReader(continueBook.id)}
                  >
                    <Play size={14} fill="currentColor" />
                    继续阅读
                  </button>
                  <span className="today-remaining">
                    {remaining === null ? '再读一会儿即可估算剩余时间' : `剩余 ${remainingText(remaining)}`}
                  </span>
                </div>
              </div>

              <div className="today-goal">
                <ProgressRing percent={goalPercent} size={124} stroke={11}>
                  <div className="ring-value">{percentText(goalPercent)}%</div>
                  <div className="ring-sub">
                    今日 {todayMinutes}/{goalMinutes} 分钟
                  </div>
                </ProgressRing>
                <div className="today-goal-sub">
                  本书已读 {percentText(bookPercent)}%
                </div>
              </div>
            </div>
          ) : null}

          {groups.map((group) => (
            <section className="lib-section" key={group.key}>
              <div className="lib-section-head">
                <h2 className="section-title">
                  {group.title}
                  <span className="section-count">{group.books.length}</span>
                </h2>
              </div>
              <div className="book-grid">
                {group.books.map((book) => {
                  const bookPct = percentMap.get(book.id) ?? 0
                  return (
                    <div className="book-item" key={book.id}>
                      <div className="book-cover" onClick={() => openDetail(book.id)}>
                        <BookCover book={book} />
                        {book.volume ? <span className="book-badge">{book.volume}</span> : null}
                        {bookPct > 0.001 ? (
                          <div className="book-progress">
                            <i style={{ width: `${percentText(bookPct)}%` }} />
                          </div>
                        ) : null}
                        <div className="book-overlay">
                          <div className="book-overlay-title">{book.title}</div>
                          <div className="book-overlay-sub">
                            {book.author} · {book.chapterCount} 章
                          </div>
                        </div>
                      </div>
                      <div style={{ position: 'absolute', top: 5, left: 5 }}>
                        <Dropdown
                          align="left"
                          trigger={
                            <span className="book-menu-btn">
                              <MoreHorizontal size={15} />
                            </span>
                          }
                        >
                          {(close) => (
                            <>
                              <button
                                onClick={() => {
                                  close()
                                  openDetail(book.id)
                                }}
                              >
                                <BookPlus size={14} />
                                查看详情
                              </button>
                              <button
                                onClick={() => {
                                  close()
                                  void openReader(book.id)
                                }}
                              >
                                <Play size={14} />
                                开始阅读
                              </button>
                              <button
                                onClick={() => {
                                  close()
                                  void window.api.library.reveal(book.id)
                                }}
                              >
                                <FolderOpen size={14} />
                                在文件夹中显示
                              </button>
                              <button
                                disabled
                                title="网盘同步将在 M5 接入"
                                onClick={() => {
                                  close()
                                  toast('info', '书籍文件上传将在同步阶段接入')
                                }}
                              >
                                <CloudUpload size={14} />
                                {book.syncUpload ? '取消上传到网盘' : '上传到网盘'}
                              </button>
                              <hr />
                              <button
                                onClick={() => {
                                  close()
                                  void updateBook(book.id, { hidden: true })
                                }}
                              >
                                <Trash2 size={14} />
                                暂时隐藏
                              </button>
                              <button
                                className="danger"
                                onClick={() => {
                                  close()
                                  void confirmDelete(book, false)
                                }}
                              >
                                移出书库（保留文件）
                              </button>
                              <button
                                className="danger"
                                onClick={() => {
                                  close()
                                  void confirmDelete(book, true)
                                }}
                              >
                                删除书籍与文件
                              </button>
                            </>
                          )}
                        </Dropdown>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}

          {groups.length === 0 ? (
            <EmptyState icon={<BookPlus size={26} />} title="这个系列里没有书籍" />
          ) : null}
        </>
      )}
    </div>
  )
}
