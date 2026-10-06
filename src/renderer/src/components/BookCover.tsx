import type { Book } from '@shared/types'
import { gradientOf, mediaUrl } from '../lib/format'

/** 有封面用封面，没有封面用由书名生成的渐变占位 */
export function BookCover({ book, className }: { book: Book; className?: string }) {
  if (book.coverFile) {
    return <img className={className} src={mediaUrl(book.coverFile)} alt={book.title} draggable={false} />
  }
  return (
    <div className={`book-cover-fallback ${className ?? ''}`} style={{ background: gradientOf(book.id) }}>
      {book.title}
    </div>
  )
}
