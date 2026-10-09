import { useEffect, useRef, useState } from 'react'
import { Check, Copy, NotebookPen, Pencil, Trash2, X } from 'lucide-react'
import { ANNOTATION_COLORS, COLOR_LABELS, quotePreview, type AnnotationPlan } from '@shared/annotations'
import type { AnnotationColor, AnnotationStyle } from '@shared/types'

export interface AnnotationToolbarTarget {
  /** 已有标注的 id；null 表示这是一次新选区 */
  id: string | null
  color: AnnotationColor
  style: AnnotationStyle
  note: string
  anchor: {
    blockIndex: number
    tokenIndex: number
    start: number
    endBlockIndex: number
    endTokenIndex: number
    end: number
  }
  quote: string
  /**
   * 这次选区盖住的已有标注（新选区才有），已经算好怎么处理：
   * remove = 整段被盖住要删掉；trim = 只盖住一部分，要裁成剩下的那几段。
   */
  covered?: AnnotationPlan
  /** true = 从笔记图标点开的「看笔记」模式：默认展开笔记卡片 */
  viewNote?: boolean
  /** 用户点了「笔记」：即使刚建的标注还没有备注，也把输入框留着 */
  noteIntent?: boolean
  /** 相对正文容器的位置 */
  left: number
  top: number
}

interface Props {
  target: AnnotationToolbarTarget
  /** 备注输入框最长字数 */
  noteMax: number
  onPickColor: (color: AnnotationColor) => void
  onPickStyle: (style: AnnotationStyle) => void
  onSaveNote: (note: string) => void
  onDelete: () => void
  onClose: () => void
}

/**
 * 选中正文后浮在上方的菜单（样式参考 Moeli：第一排样式与颜色，第二排动作）。
 * 已有标注时改颜色 / 改样式 / 写备注都是即时的，不需要确认。
 */
export function AnnotationToolbar({
  target,
  noteMax,
  onPickColor,
  onPickStyle,
  onSaveNote,
  onDelete,
  onClose
}: Props) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(target.note)
  const [copied, setCopied] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  /**
   * 「换了一条标注」才重置草稿。
   * 不能用 target.note 当依赖：store 每次刷新都会给出新的 note 值，
   * 于是输入框里的字会被一路重置回旧值 —— 表现就是「备注写不上去」。
   * 用 id + 模式做键，只有真正换了目标才重置。
   */
  const targetKey = `${target.id ?? 'new'}|${target.viewNote ? 'view' : 'edit'}`
  useEffect(() => {
    setDraft(target.note)
    setNoteOpen(Boolean(target.viewNote))
    setEditing(false)
    setCopied(false)
    // 只在换目标时跑一次；target.note 取当时的值即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  // 点「看笔记」进来的：直接展示内容；点「编辑」才切成输入框
  useEffect(() => {
    if (target.viewNote && !editing) setNoteOpen(true)
  }, [target.viewNote, editing])

  // 用户点了「笔记」：新建标注那一步结束后，输入框要留着，别给关上
  useEffect(() => {
    if (target.noteIntent) setNoteOpen(true)
  }, [target.noteIntent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (noteOpen) setNoteOpen(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [noteOpen, onClose])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(target.quote)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className="ann-toolbar"
      ref={wrapRef}
      style={{ left: target.left, top: target.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className={`ann-toolbar-item${target.style === 'highlight' ? ' on' : ''}`}
        title="高亮"
        onClick={() => onPickStyle('highlight')}
      >
        高亮
      </button>
      <button
        className={`ann-toolbar-item${target.style === 'underline' ? ' on' : ''}`}
        title="下划线"
        onClick={() => onPickStyle('underline')}
      >
        下划线
      </button>
      <span className="ann-toolbar-sep" />
      {ANNOTATION_COLORS.map((color) => (
        <button
          key={color}
          className={`ann-swatch ann-${color}${target.color === color ? ' on' : ''}`}
          style={{ background: 'var(--rc-bg)', borderColor: target.color === color ? 'var(--rc)' : undefined }}
          title={COLOR_LABELS[color]}
          onClick={() => onPickColor(color)}
        />
      ))}
      <span className="ann-toolbar-sep" />
      <button className="ann-toolbar-item" title="复制原文" onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied ? '已复制' : '复制'}
      </button>
      <button
        className={`ann-toolbar-item${target.note ? ' on' : ''}`}
        title={target.id ? '写笔记' : '划线并写笔记'}
        onClick={() => setNoteOpen((v) => !v)}
      >
        <NotebookPen size={15} />
        笔记
      </button>
      {target.id ? (
        <button className="ann-toolbar-item" title="删除这条记录" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      ) : null}
      <span className="ann-toolbar-sep" />
      <button className="ann-toolbar-item" title="关闭" onClick={onClose}>
        <X size={15} />
      </button>

      {noteOpen ? (
        <div
          className="ann-note-pop"
          style={{ left: 0, top: 'calc(100% + 8px)' }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {target.viewNote && !editing ? (
            /* 从笔记图标点进来：先看内容，想改再点「编辑」 */
            <>
              <div className="ann-note-view">{target.note || '（这条备注是空的）'}</div>
              <div className="ann-note-pop-foot">
                <span className="ann-note-pop-hint">{target.quote ? `「${quotePreview(target.quote)}」` : ''}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                  <Pencil size={13} />
                  编辑
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setNoteOpen(false)}>
                  关闭
                </button>
              </div>
            </>
          ) : (
            <>
              <textarea
                autoFocus
                className="ann-note-pop-ta"
                maxLength={noteMax}
                placeholder="写下你的想法…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setNoteOpen(false)
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    onSaveNote(draft)
                    setNoteOpen(false)
                  }
                }}
              />
              <div className="ann-note-pop-foot">
                <span className="ann-note-pop-hint">Ctrl+Enter 保存</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setDraft(target.note)
                    setNoteOpen(false)
                  }}
                >
                  取消
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    onSaveNote(draft)
                    setNoteOpen(false)
                  }}
                >
                  保存
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
