import { BookOpen, Clock, FileText, Play, Type } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '../store/app'
import { BookCover } from './BookCover'
import { Modal } from './ui'
import { coverHero, durationText, formatDateTime, formatWordCount, percentText } from '../lib/format'

function DetailStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="detail-stat">
      <div className="detail-stat-label">
        {icon}
        {label}
      </div>
      <div className="detail-stat-value">{value}</div>
    </div>
  )
}

/** 点击书架上的书弹出的详情面板（封面、进度、阅读时间、格式、字数、状态、简介） */
export function BookDetailModal() {
  const detailBookId = useApp((s) => s.detailBookId)
  const books = useApp((s) => s.books)
  const stats = useApp((s) => s.stats)
  const closeDetail = useApp((s) => s.closeDetail)
  const openReader = useApp((s) => s.openReader)

  const book = books.find((b) => b.id === detailBookId) ?? null
  const stat = stats?.books.find((item) => item.bookId === detailBookId)
  const percent = stat?.percent ?? 0
  const seconds = stat?.seconds ?? 0
  const lastAt = stat?.lastAt ?? 0
  const status = percent >= 0.99 ? '已读完' : percent > 0.001 ? '阅读中' : '未开始'

  return (
    <Modal open={Boolean(book)} title="书籍详情" onClose={closeDetail} width={640}>
      {book ? (
        <>
          <div className="detail-hero" style={{ background: coverHero(book.coverColor, book.id) }}>
            <div className="detail-cover">
              <BookCover book={book} />
            </div>
            <div className="detail-head">
              <h2 className="detail-title">{book.title}</h2>
              <div className="detail-author">{book.author}</div>
              <div className="detail-tags">
                {book.volume ? <span className="detail-tag">第 {book.volume} 卷</span> : null}
                {book.seriesKey ? <span className="detail-tag">{book.seriesKey}</span> : null}
                <span className="detail-tag">
                  {book.chapterCount} 章 · {formatWordCount(book.wordCount)}
                </span>
              </div>
            </div>
          </div>

          <div className="detail-progress">
            <div>
              <div className="detail-progress-title">阅读进度</div>
              <div className="detail-progress-sub">
                {lastAt > 0
                  ? `${formatDateTime(lastAt)} · 已读完 ${percentText(percent)} %`
                  : '还没有开始阅读'}
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                closeDetail()
                void openReader(book.id)
              }}
            >
              <Play size={14} fill="currentColor" />
              {percent > 0.001 ? '继续阅读' : '开始阅读'}
            </button>
          </div>

          <div className="detail-stats">
            <DetailStat icon={<Clock size={13} />} label="阅读时间" value={durationText(seconds)} />
            <DetailStat icon={<FileText size={13} />} label="书籍格式" value={book.format.toUpperCase()} />
            <DetailStat icon={<Type size={13} />} label="总字数" value={formatWordCount(book.wordCount)} />
            <DetailStat icon={<BookOpen size={13} />} label="阅读状态" value={status} />
          </div>

          <div className="detail-desc">
            <h3>书籍简介</h3>
            <p>{book.description || '这本书没有提供简介。'}</p>
          </div>

          <div className="detail-file">
            <span>文件名：{book.fileName}</span>
            {book.metaTitle && book.metaTitle !== book.title ? (
              <span>EPUB 书名：{book.metaTitle}</span>
            ) : null}
          </div>
        </>
      ) : null}
    </Modal>
  )
}
