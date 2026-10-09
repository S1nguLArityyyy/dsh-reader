import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Bookmark as BookmarkIcon, Check } from 'lucide-react'
import { NOTE_MAX } from '@shared/bookmarks'
import type { Bookmark } from '@shared/types'
import { useApp, bookPercent } from '../store/app'

interface Props {
  /** 阅读器当前这一章 */
  chapterIndex: number
  chapterTitle: string
  /** 当前位置（章内比例）与原文摘录，由 ReaderPage 现场取 */
  currentRatio: () => number
  currentExcerpt: () => string
  /** 按钮与气泡都停用（章节还没加载出来时） */
  disabled?: boolean
  /** 顶栏按钮本身，供 Ctrl+B 直接触发 */
  buttonRef?: MutableRefObject<HTMLButtonElement | null>
}

/**
 * 阅读器顶栏的书签按钮。
 * 当前位置没有书签 → 点一下直接加（只弹一条带「撤销」的提示，不打断阅读）；
 * 已经有书签 → 点开小气泡改备注 / 删除。
 */
export function BookmarkButton({
  chapterIndex,
  chapterTitle,
  currentRatio,
  currentExcerpt,
  disabled,
  buttonRef
}: Props) {
  const bookId = useApp((s) => s.reader.bookId)
  const bookmarks = useApp((s) => s.bookmarks)
  const addBookmark = useApp((s) => s.addBookmark)
  const updateBookmark = useApp((s) => s.updateBookmark)
  const removeBookmark = useApp((s) => s.removeBookmark)

  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // 同一章里位置相差很小就算「这一处」；换章或滚动之后自动跟着变
  const here = bookmarks.find(
    (item) => item.bookId === bookId && item.chapterIndex === chapterIndex && Math.abs(item.scrollRatio - currentRatio()) <= 0.02
  )

  /* 点别处 / 按 Esc 关掉气泡 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!bookId) return null


  const add = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const ratio = currentRatio()
    const book = useApp.getState().reader.book
    const created = await addBookmark({
      bookId,
      chapterIndex,
      chapterTitle,
      scrollRatio: ratio,
      percent: bookPercent(book, chapterIndex, ratio),
      excerpt: currentExcerpt()
    })
    setBusy(false)
    if (created) {
      useApp.getState().toast('success', `已加书签 · ${chapterTitle} ${Math.round(ratio * 100)}%`, {
        label: '撤销',
        run: () => void useApp.getState().removeBookmark(created.id)
      })
    }
  }

  const toggle = async (): Promise<void> => {
    if (disabled || busy) return
    if (!here) {
      await add()
      return
    }
    if (open) {
      setOpen(false)
      return
    }
    setDraft(here.note)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    if (!here || busy) return
    setBusy(true)
    await updateBookmark(here.id, { note: draft })
    setBusy(false)
    setOpen(false)
  }

  return (
    <div className="reader-bookmark" ref={wrapRef}>
      <button
        ref={buttonRef}
        className={`icon-btn sm${here ? ' active' : ''}`}
        style={here ? { color: 'var(--primary)' } : undefined}
        title={here ? '已加书签 · 点按编辑备注' : '加书签（当前位置）'}
        disabled={disabled}
        onClick={() => void toggle()}
      >
        <BookmarkIcon size={17} fill={here ? 'currentColor' : 'none'} />
      </button>

      {open && here ? (
        <div className="bookmark-pop">
          <div className="bookmark-pop-head">
            书签 · {chapterTitle}（{Math.round(here.scrollRatio * 100)}%）
          </div>
          <textarea
            className="bookmark-note"
            autoFocus
            rows={3}
            maxLength={NOTE_MAX}
            placeholder="备注（可留空）"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void save()
              }
            }}
          />
          <div className="bookmark-pop-foot">
            <span className="bookmark-pop-hint">Ctrl+Enter 保存</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setOpen(false)
                void removeBookmark(here.id)
              }}
            >
              删除书签
            </button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
              <Check size={14} />
              保存
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
