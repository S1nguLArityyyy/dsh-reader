import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Info,
  List,
  Type
} from 'lucide-react'
import type { ReaderTheme } from '@shared/types'
import { useApp } from '../store/app'
import { FONT_STACKS, READER_THEMES, type FontKey } from '../lib/reader-theme'
import { percentText } from '../lib/format'
import { SegmentedControl, Slider } from '../components/ui'

const COLUMN_GAP = 48

export function ReaderPage() {
  const reader = useApp((s) => s.reader)
  const settings = useApp((s) => s.settings)
  const closeReader = useApp((s) => s.closeReader)
  const goToChapter = useApp((s) => s.goToChapter)
  const saveSettings = useApp((s) => s.saveSettings)

  const [panel, setPanel] = useState<'none' | 'toc' | 'settings'>('none')
  const [ratio, setRatio] = useState(0)
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(1)

  const bodyRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const ratioRef = useRef(0)
  const lastRatioUpdate = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const restoredBook = useRef<string | null>(null)

  const readerSettings = settings?.reader
  const theme = READER_THEMES[readerSettings?.theme ?? 'paper']
  const mode = readerSettings?.mode ?? 'scroll'
  const pageWidth = readerSettings?.pageWidth ?? 720

  const { bookId, chapters, chapterIndex, html, loading, book } = reader

  /* ---------- 进度持久化 ---------- */
  const persist = useCallback(
    (value: number) => {
      const state = useApp.getState().reader
      if (!state.bookId || state.chapters.length === 0) return
      const percent = (state.chapterIndex + value) / state.chapters.length
      void window.api.reader.setProgress(state.bookId, {
        chapterIndex: state.chapterIndex,
        chapterTitle: state.chapterLabel,
        scrollRatio: value,
        percent
      })
    },
    []
  )

  const schedulePersist = useCallback(
    (value: number) => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => persist(value), 900)
    },
    [persist]
  )

  /* ---------- 阅读计时 ---------- */
  useEffect(() => {
    if (!bookId) return
    let last = Date.now()
    let acc = 0
    const flush = (): void => {
      if (acc >= 1) {
        void window.api.reader.tick(bookId, acc)
        acc = 0
      }
    }
    const timer = window.setInterval(() => {
      const now = Date.now()
      const delta = (now - last) / 1000
      last = now
      if (document.hidden || !document.hasFocus()) return
      acc += delta
      if (acc >= 20) flush()
    }, 4000)
    const onBlur = (): void => {
      last = Date.now()
      flush()
    }
    const onFocus = (): void => {
      last = Date.now()
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onBlur)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onBlur)
      flush()
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      persist(ratioRef.current)
    }
  }, [bookId, persist])

  /* ---------- 滚动进度 ---------- */
  useEffect(() => {
    const el = bodyRef.current
    if (!el || mode !== 'scroll') return
    const onScroll = (): void => {
      const max = el.scrollHeight - el.clientHeight
      const value = max > 8 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0
      ratioRef.current = value
      const now = Date.now()
      if (now - lastRatioUpdate.current > 150) {
        lastRatioUpdate.current = now
        setRatio(value)
      }
      schedulePersist(value)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [mode, chapterIndex, html, schedulePersist])

  /* ---------- 翻页模式：分页计算 ---------- */
  useLayoutEffect(() => {
    if (mode !== 'paged') {
      setPages(1)
      setPage(0)
      return
    }
    const el = pageRef.current
    if (!el) {
      setPages(1)
      return
    }
    const total = Math.max(1, Math.round((el.scrollWidth + COLUMN_GAP) / (pageWidth + COLUMN_GAP)))
    setPages(total)
    setPage(0)
    ratioRef.current = 0
    setRatio(0)
  }, [mode, pageWidth, html, chapterIndex, readerSettings?.fontSize, readerSettings?.lineHeight])

  /* ---------- 恢复上次位置 ---------- */
  useEffect(() => {
    if (!bookId || !html) return
    if (restoredBook.current === bookId) return
    restoredBook.current = bookId
    const saved = reader.scrollRatio
    if (saved > 0.01) {
      if (mode === 'scroll') {
        const el = bodyRef.current
        if (el) {
          const max = el.scrollHeight - el.clientHeight
          el.scrollTop = max * saved
          ratioRef.current = saved
          setRatio(saved)
        }
      } else {
        const target = Math.min(pages - 1, Math.round(saved * pages))
        setPage(Math.max(0, target))
      }
    }
  }, [bookId, html, mode, pages, reader.scrollRatio])

  /* ---------- 键盘 ---------- */
  const turn = useCallback(
    (delta: number) => {
      if (mode === 'paged') {
        const next = page + delta
        if (next < 0) {
          if (chapterIndex > 0) void goToChapter(chapterIndex - 1)
          return
        }
        if (next >= pages) {
          if (chapterIndex < chapters.length - 1) void goToChapter(chapterIndex + 1)
          return
        }
        setPage(next)
        const value = pages > 1 ? next / pages : 0
        ratioRef.current = value
        setRatio(value)
        schedulePersist(value)
        return
      }
      const el = bodyRef.current
      if (el) el.scrollBy({ top: delta * (el.clientHeight * 0.86), behavior: 'smooth' })
    },
    [mode, page, pages, chapterIndex, chapters.length, goToChapter, schedulePersist]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        turn(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        turn(-1)
      } else if (e.key === 'Escape') {
        if (panel !== 'none') setPanel('none')
        else closeReader()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [turn, panel, closeReader])

  const totalPercent = chapters.length > 0 ? (chapterIndex + ratio) / chapters.length : 0

  const readerStyle = useMemo(
    () =>
      ({
        '--reader-bg': theme.bg,
        '--reader-text': theme.text,
        '--reader-quote': theme.quote,
        '--reader-width': `${pageWidth}px`,
        '--reader-padding': `${readerSettings?.padding ?? 36}px`,
        '--reader-size': `${readerSettings?.fontSize ?? 18}px`,
        '--reader-lh': String(readerSettings?.lineHeight ?? 1.9),
        '--reader-font': FONT_STACKS[(readerSettings?.fontFamily ?? 'system') as FontKey].css
      }) as React.CSSProperties,
    [theme, pageWidth, readerSettings]
  )

  if (!book) {    return (
      <div className="reader" style={readerStyle}>
        <div className="reader-bar">
          <button className="icon-btn sm" onClick={closeReader}>
            <ArrowLeft size={18} />
          </button>
          <span className="reader-bar-title">未打开书籍</span>
        </div>
        <div className="reader-empty">
          <Info size={26} />
          <div>请从书库中选择一本书开始阅读</div>
        </div>
      </div>
    )
  }

  const pageContent = (
    <div
      ref={pageRef}
      className={`reader-page${mode === 'paged' ? ' paged' : ''}`}
      style={
        mode === 'paged'
          ? {
              width: `${pageWidth}px`,
              maxWidth: 'none',
              columnWidth: `${pageWidth}px`,
              columnGap: `${COLUMN_GAP}px`,
              columnFill: 'auto',
              transform: `translateX(-${page * (pageWidth + COLUMN_GAP)}px)`
            }
          : undefined
      }
    >
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <div className="reader-chapter-nav">
        <button
          className="btn btn-ghost btn-sm"
          disabled={chapterIndex === 0}
          onClick={() => void goToChapter(chapterIndex - 1)}
        >
          <ChevronLeft size={15} />
          上一章
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={chapterIndex >= chapters.length - 1}
          onClick={() => void goToChapter(chapterIndex + 1)}
        >
          下一章
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  )

  return (
    <div className="reader" style={readerStyle}>
      <div className="reader-bar">
        <button className="icon-btn sm" onClick={closeReader} title="返回书库">
          <ArrowLeft size={18} />
        </button>
        <span className="reader-bar-title">{book.title}</span>
        <span className="reader-bar-sub">
          {chapterIndex + 1}/{chapters.length} · {reader.chapterLabel}
        </span>
        <div className="reader-spacer" />
        <button
          className={`icon-btn sm${panel === 'toc' ? ' active' : ''}`}
          title="目录"
          onClick={() => setPanel(panel === 'toc' ? 'none' : 'toc')}
        >
          <List size={17} />
        </button>
        <button
          className={`icon-btn sm${panel === 'settings' ? ' active' : ''}`}
          title="排版设置"
          onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')}
        >
          <Type size={17} />
        </button>
      </div>

      <div
        className={`reader-body${mode === 'paged' ? ' paged' : ''}`}
        ref={bodyRef}
      >
        {loading && !html ? (
          <div className="reader-loading">正在解析章节…</div>
        ) : mode === 'paged' ? (
          <div className="reader-viewport" style={{ width: `${pageWidth}px` }}>
            {pageContent}
          </div>
        ) : (
          pageContent
        )}
      </div>

      <div className="reader-foot">
        <button className="icon-btn sm" onClick={() => turn(-1)} title="上一页">
          <ChevronLeft size={17} />
        </button>
        <span>{percentText(totalPercent)}%</span>
        <div className="reader-progress">
          <i style={{ width: `${percentText(totalPercent)}%` }} />
        </div>
        <button className="icon-btn sm" onClick={() => turn(1)} title="下一页">
          <ChevronRight size={17} />
        </button>
      </div>

      {panel === 'toc' ? (
        <div className="reader-panel">
          <div className="reader-panel-head">
            <span>目录</span>
            <button className="icon-btn sm" onClick={() => setPanel('none')}>
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="reader-panel-body">
            {reader.toc.length === 0 ? (
              <div className="setting-hint" style={{ padding: 12 }}>
                这本书没有提供目录，可在底部按章翻页。
              </div>
            ) : (
              reader.toc.map((entry) => (
                <button
                  key={entry.id}
                  className={`toc-item${entry.chapterIndex === chapterIndex ? ' active' : ''}`}
                  style={{ paddingLeft: 12 + entry.level * 14 }}
                  onClick={() => {
                    void goToChapter(entry.chapterIndex)
                    setPanel('none')
                  }}
                >
                  {entry.label}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {panel === 'settings' ? (
        <div className="reader-panel">
          <div className="reader-panel-head">
            <span>排版设置</span>
            <button className="icon-btn sm" onClick={() => setPanel('none')}>
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="reader-panel-body">
            <div className="panel-row">
              <div className="panel-row-title">
                <span>字号</span>
                <span className="range-value">{readerSettings?.fontSize ?? 18} px</span>
              </div>
              <Slider
                value={readerSettings?.fontSize ?? 18}
                min={14}
                max={30}
                onChange={(v) => void saveSettings({ reader: { ...readerSettings!, fontSize: v } })}
              />
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>行距</span>
                <span className="range-value">{(readerSettings?.lineHeight ?? 1.9).toFixed(1)}</span>
              </div>
              <Slider
                value={readerSettings?.lineHeight ?? 1.9}
                min={1.4}
                max={2.6}
                step={0.1}
                onChange={(v) => void saveSettings({ reader: { ...readerSettings!, lineHeight: v } })}
              />
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>页宽</span>
                <span className="range-value">{pageWidth} px</span>
              </div>
              <Slider
                value={pageWidth}
                min={560}
                max={920}
                step={20}
                onChange={(v) => void saveSettings({ reader: { ...readerSettings!, pageWidth: v } })}
              />
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>页边距</span>
                <span className="range-value">{readerSettings?.padding ?? 36} px</span>
              </div>
              <Slider
                value={readerSettings?.padding ?? 36}
                min={12}
                max={80}
                step={4}
                onChange={(v) => void saveSettings({ reader: { ...readerSettings!, padding: v } })}
              />
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>字体</span>
              </div>
              <select
                className="select"
                style={{ width: '100%' }}
                value={readerSettings?.fontFamily ?? 'system'}
                onChange={(e) =>
                  void saveSettings({ reader: { ...readerSettings!, fontFamily: e.target.value as FontKey } })
                }
              >
                {Object.entries(FONT_STACKS).map(([key, spec]) => (
                  <option key={key} value={key}>
                    {spec.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>主题</span>
              </div>
              <div className="theme-swatches">
                {(Object.keys(READER_THEMES) as ReaderTheme[]).map((key) => (
                  <button
                    key={key}
                    title={READER_THEMES[key].label}
                    className={`theme-swatch${readerSettings?.theme === key ? ' active' : ''}`}
                    style={{ background: READER_THEMES[key].swatch, color: READER_THEMES[key].text }}
                    onClick={() => void saveSettings({ reader: { ...readerSettings!, theme: key } })}
                  >
                    A
                  </button>
                ))}
              </div>
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>翻页方式</span>
              </div>
              <SegmentedControl<'scroll' | 'paged'>
                size="sm"
                value={mode}
                onChange={(v) => void saveSettings({ reader: { ...readerSettings!, mode: v } })}
                options={[
                  { value: 'scroll', label: '滚动' },
                  { value: 'paged', label: '翻页' }
                ]}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
