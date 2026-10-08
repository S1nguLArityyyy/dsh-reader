import { useEffect, useMemo, useState } from 'react'
import {
  BookPlus,
  Check,
  CheckSquare,
  CloudUpload,
  EyeOff,
  FolderOpen,
  FolderPlus,
  Layers,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { Book } from '@shared/types'
import { useApp } from '../store/app'
import { BookCover } from '../components/BookCover'
import { CollectionModal } from '../components/CollectionModal'
import { Dropdown, EmptyState, ProgressRing } from '../components/ui'
import { coverFade, percentText, remainingText } from '../lib/format'
import { groupBooks, sortBooks } from '../lib/library'

export function LibraryPage() {
  const books = useApp((s) => s.books)
  const stats = useApp((s) => s.stats)
  const settings = useApp((s) => s.settings)
  const seriesFilter = useApp((s) => s.seriesFilter)
  const setSeriesFilter = useApp((s) => s.setSeriesFilter)
  const search = useApp((s) => s.search)
  const setSearch = useApp((s) => s.setSearch)
  const selectMode = useApp((s) => s.selectMode)
  const selected = useApp((s) => s.selected)
  const toggleSelectMode = useApp((s) => s.toggleSelectMode)
  const toggleSelected = useApp((s) => s.toggleSelected)
  const selectAll = useApp((s) => s.selectAll)
  const clearSelection = useApp((s) => s.clearSelection)
  const bulkRemove = useApp((s) => s.bulkRemove)
  const bulkHide = useApp((s) => s.bulkHide)
  const importDialog = useApp((s) => s.importDialog)
  const importFolderDialog = useApp((s) => s.importFolderDialog)
  const openReader = useApp((s) => s.openReader)
  const openDetail = useApp((s) => s.openDetail)
  const refreshAll = useApp((s) => s.refreshAll)
  const removeBook = useApp((s) => s.removeBook)
  const updateBook = useApp((s) => s.updateBook)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)

  const [collectionIds, setCollectionIds] = useState<string[] | null>(null)

  // 截图 / 深链用：?collection=1 直接打开合集弹窗
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('collection') !== '1') return
    if (books.length >= 2) setCollectionIds(books.slice(0, 2).map((book) => book.id))
  }, [books])

  const percentMap = useMemo(
    () => new Map((stats?.books ?? []).map((item) => [item.bookId, item.percent])),
    [stats]
  )

  const sort = settings?.librarySort ?? 'recent'
  const query = search.trim().toLowerCase()

  const matched = useMemo(() => {
    if (!query) return books
    return books.filter((book) =>
      [book.title, book.metaTitle, book.author, book.seriesKey, book.manualSeries]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    )
  }, [books, query])

  const sorted = useMemo(() => sortBooks(matched, sort), [matched, sort])
  const allGroups = useMemo(() => groupBooks(sorted), [sorted])
  const groups = useMemo(
    () => (seriesFilter ? allGroups.filter((g) => g.key === seriesFilter) : allGroups),
    [allGroups, seriesFilter]
  )
  const activeGroup = allGroups.find((g) => g.key === seriesFilter)

  const continueBook = useMemo(() => {
    const list = sortBooks(books, 'recent')
    if (list.length === 0) return null
    if (stats?.todayBookId) {
      const hit = list.find((b) => b.id === stats.todayBookId)
      if (hit) return hit
    }
    const inProgress = list.find((b) => {
      const percent = percentMap.get(b.id) ?? 0
      return percent > 0.001 && percent < 0.999
    })
    return inProgress ?? list[0]
  }, [books, stats, percentMap])

  const goalMinutes = settings?.dailyGoalMinutes ?? 30
  const todaySeconds = stats?.todaySeconds ?? 0
  const todayMinutes = Math.floor(todaySeconds / 60)
  const goalPercent = goalMinutes > 0 ? Math.min(1, todayMinutes / goalMinutes) : 0
  const remaining = stats?.todayRemainingSeconds ?? null
  const bookProgress = continueBook ? (percentMap.get(continueBook.id) ?? 0) : 0

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

  const renderBook = (book: Book): React.ReactNode => {
    const bookPct = percentMap.get(book.id) ?? 0
    const isSelected = selected.includes(book.id)
    return (
      <div className={`book-item${isSelected ? ' selected' : ''}`} key={book.id}>
        <div
          className="book-cover"
          onClick={() => (selectMode ? toggleSelected(book.id) : openDetail(book.id))}
        >
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
              {book.author} · {book.chapterCount} 章 · 已读 {percentText(bookPct)}%
            </div>
          </div>
          {selectMode ? (
            <span className={`book-check${isSelected ? ' on' : ''}`}>
              {isSelected ? <Check size={15} /> : null}
            </span>
          ) : null}
        </div>

        {!selectMode ? (
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
                      setCollectionIds([book.id])
                    }}
                  >
                    <Layers size={14} />
                    归入合集…
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
                    <EyeOff size={14} />
                    暂时隐藏
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      close()
                      void confirmDelete(book, false)
                    }}
                  >
                    <button
                      onClick={() => {
                        void window.api.library.clearRecords(book.id).then(() => refreshAll())
                        close()
                      }}
                    >
                      清除阅读记录（保留书）
                    </button>
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
        ) : null}
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">
          {query ? '搜索结果' : activeGroup ? activeGroup.title : '本地书库'}
        </h1>
        <div className="head-actions">
          <button className="icon-btn" title="刷新（重新读取书库与记录）" onClick={() => void refreshAll()}>
            <RefreshCw size={19} />
          </button>
          {seriesFilter && !query ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setSeriesFilter(null)}>
              显示全部
            </button>
          ) : null}
          <button
            className={`icon-btn${selectMode ? ' active' : ''}`}
            title={selectMode ? '退出多选' : '多选管理'}
            onClick={toggleSelectMode}
          >
            <CheckSquare size={19} />
          </button>
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
                    setCollectionIds(books.map((b) => b.id))
                  }}
                >
                  <Layers size={15} />
                  批量归入合集…
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

      {/* 手机端：系列 / 合集横向筛选（桌面端用侧边栏的二级菜单，这里由 CSS 隐藏） */}
      <div className="series-chips">
        <button
          className={`series-chip${seriesFilter === null ? ' active' : ''}`}
          onClick={() => setSeriesFilter(null)}
        >
          全部 {books.length}
        </button>
        {allGroups
          .filter((group) => group.books.length > 0)
          .map((group) => (
            <button
              key={group.key}
              className={`series-chip${seriesFilter === group.key ? ' active' : ''}`}
              onClick={() => setSeriesFilter(group.key)}
            >
              {group.title} {group.books.length}
            </button>
          ))}
      </div>

      <div className="lib-search">
        <Search size={16} />
        <input
          className="lib-search-input"
          placeholder="搜索书名、作者或系列…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search ? (
          <button className="icon-btn sm" title="清空" onClick={() => setSearch('')}>
            <X size={15} />
          </button>
        ) : null}
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
          {!seriesFilter && !query ? (
            <div
              className="card today-card"
              style={{ background: coverFade(continueBook?.coverColor ?? null, continueBook?.id ?? 'empty') }}
            >
              <div
                className="today-cover"
                /* 容器底色 = 封面主色 ✓ 封面比容器窄时那条边与封面同色 ✓ 看不出缝 ✓ */
                style={{ background: continueBook?.coverColor ?? 'transparent' }}
              >
                {continueBook ? <BookCover book={continueBook} /> : null}
              </div>

              <div className="today-info">
                <div className="today-label">今日阅读</div>
                <div className="today-book" title={continueBook?.title}>
                  {continueBook?.title ?? '还没有书籍'}
                </div>
                <div className="today-author">{continueBook?.author ?? '导入一本 EPUB 开始阅读'}</div>
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
                <div className="today-goal-sub">全书已读 {percentText(bookProgress)}%</div>
              </div>
            </div>
          ) : null}

          {query ? (
            <section className="lib-section">
              <div className="lib-section-head">
                <h2 className="section-title">
                  共 {sorted.length} 本
                  <span className="section-count">匹配「{search.trim()}」</span>
                </h2>
              </div>
              {sorted.length > 0 ? (
                <div className="book-grid">{sorted.map(renderBook)}</div>
              ) : (
                <EmptyState icon={<Search size={26} />} title="没有找到匹配的书" desc="试试书名、作者或系列名的一部分" />
              )}
            </section>
          ) : (
            groups.map((group) => (
              <section className="lib-section" key={group.key}>
                <div className="lib-section-head">
                  <h2 className="section-title">
                    {group.title}
                    <span className="section-count">{group.books.length}</span>
                    {group.manual ? <span className="group-tag manual">手动合集</span> : null}
                    {group.fuzzy ? <span className="group-tag fuzzy">模糊匹配</span> : null}
                  </h2>
                </div>
                <div className="book-grid">{group.books.map(renderBook)}</div>
              </section>
            ))
          )}

          {groups.length === 0 && !query ? (
            <EmptyState icon={<BookPlus size={26} />} title="这个合集里没有书籍" />
          ) : null}
        </>
      )}

      {selectMode ? (
        <div className="select-bar">
          <span className="select-count">已选 {selected.length} 本</span>
          <button className="btn btn-ghost btn-sm" onClick={() => selectAll(sorted.map((b) => b.id))}>
            全选
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearSelection} disabled={selected.length === 0}>
            清空
          </button>
          <div className="select-spacer" />
          <button
            className="btn btn-ghost btn-sm"
            disabled={selected.length === 0}
            onClick={() => setCollectionIds(selected)}
          >
            <Layers size={14} />
            归入合集
          </button>
          <button className="btn btn-ghost btn-sm" disabled={selected.length === 0} onClick={() => void bulkHide()}>
            <EyeOff size={14} />
            隐藏
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={selected.length === 0}
            onClick={() => void bulkRemove(false)}
          >
            移出书库
          </button>
          <button
            className="btn btn-ghost btn-sm danger"
            disabled={selected.length === 0}
            onClick={() => void bulkRemove(true)}
          >
            <Trash2 size={14} />
            删除
          </button>
          <button className="btn btn-ghost btn-sm" onClick={toggleSelectMode}>
            退出
          </button>
        </div>
      ) : null}

      <CollectionModal bookIds={collectionIds} onClose={() => setCollectionIds(null)} />
    </div>
  )
}
