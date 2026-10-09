import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Info, List, Type } from 'lucide-react'
import type { ReaderTheme } from '@shared/types'
import { bookPercent, useApp } from '../store/app'
import { FONT_STACKS, READER_THEMES, type FontKey } from '../lib/reader-theme'
import { mediaUrl, percentText } from '../lib/format'
import { SegmentedControl, Slider } from '../components/ui'

const COLUMN_GAP = 48
const MIN_COLUMN = 340
/** 点击左右多少比例的区域翻页 */
const TAP_ZONE = 0.28
/** 滚轮翻页的节流间隔（毫秒） */
const WHEEL_LOCK = 300

export function ReaderPage() {
  const reader = useApp((s) => s.reader)
  const settings = useApp((s) => s.settings)
  const closeReader = useApp((s) => s.closeReader)
  const goToChapter = useApp((s) => s.goToChapter)
  const saveSettings = useApp((s) => s.saveSettings)
  const toast = useApp((s) => s.toast)

  const [panel, setPanel] = useState<'none' | 'toc' | 'settings'>('none')
  const [ratio, setRatio] = useState(0)
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(1)
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 })

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const ratioRef = useRef(0)
  const lastRatioUpdate = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const restoredBook = useRef<string | null>(null)
  const pendingAnchor = useRef<string | null>(null)

  const readerSettings = settings?.reader
  const theme = READER_THEMES[readerSettings?.theme ?? 'paper']
  const mode = readerSettings?.mode ?? 'scroll'
  const padding = readerSettings?.padding ?? 36
  const { bookId, chapters, chapterIndex, html, loading, book } = reader

  /* ---------- 分栏计算：按窗口宽度决定单栏还是双栏 ---------- */
  const available = Math.max(0, bodySize.width - padding * 2)
  const columns = mode === 'paged' && available >= MIN_COLUMN * 2 + COLUMN_GAP ? 2 : 1
  const columnWidth = useMemo(() => {
    if (columns === 1) return Math.min(readerSettings?.pageWidth ?? 720, Math.max(MIN_COLUMN, available))
    return Math.floor((available - COLUMN_GAP) / 2)
  }, [columns, available, readerSettings?.pageWidth])
  const screenWidth = columns * columnWidth + (columns - 1) * COLUMN_GAP
  const step = screenWidth + COLUMN_GAP

  /* ---------- 尺寸监听：用回调 ref，元素挂载/卸载时都能正确接上 ---------- */
  const observerRef = useRef<ResizeObserver | null>(null)
  const attachBody = useCallback((el: HTMLDivElement | null) => {
    bodyRef.current = el
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const update = (): void => setBodySize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    observerRef.current = observer
  }, [])

  /* ---------- 进度持久化（按读到的位置） ---------- */
  const persist = useCallback((value: number) => {
    const state = useApp.getState().reader
    if (!state.bookId || state.chapters.length === 0) return
    const percent = bookPercent(state.book, state.chapterIndex, value)
    void window.api.reader.setProgress(state.bookId, {
      chapterIndex: state.chapterIndex,
      chapterTitle: state.chapterLabel,
      scrollRatio: value,
      percent
    })
  }, [])

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

  /** 翻页模式下用于识别"换章了"：换章要回到开头，切模式/改排版不能回到开头 */
  const pagedChapter = useRef<number | null>(null)
  /** 上一次的阅读模式：用来识别"刚切回滚动模式" */
  const prevMode = useRef<'scroll' | 'paged'>('scroll')

  /*
   * 从翻页切回滚动：必须**主动**把滚动位置恢复回去。
   * 分页时滚动容器里是 .reader-viewport，滚动位置一直是 0；
   * 切回滚动后没有任何东西会把它设回来，于是看着就像"跳回本章开头"。
   * 用 useLayoutEffect 在浏览器绘制前设好，用户看不到跳动。
   */
  useLayoutEffect(() => {
    const cameFromPaged = prevMode.current === 'paged'
    prevMode.current = mode
    if (!cameFromPaged || mode !== 'scroll') return
    const el = bodyRef.current
    if (!el) return
    const value = ratioRef.current
    if (value <= 0.005) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 0) return
    el.scrollTop = max * value
    setRatio(value)
  }, [mode, html, chapterIndex])

  /* ---------- 滚动模式的进度 ---------- */
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
    if (!el || columnWidth <= 0) {
      setPages(1)
      return
    }
    const totalColumns = Math.max(1, Math.round((el.scrollWidth + COLUMN_GAP) / (columnWidth + COLUMN_GAP)))
    const screens = Math.max(1, Math.ceil(totalColumns / columns))
    setPages(screens)

    // ★ 换章必须回到章首，但切模式 / 改排版 / 缩放窗口不能 ★
    //   之前这里无条件 setPage(0) + ratio=0，于是"阅读中切滚动↔翻页"会跳回本章开头（用户反馈的 bug）
    if (pagedChapter.current !== chapterIndex) {
      pagedChapter.current = chapterIndex
      ratioRef.current = 0
      setRatio(0)
      setPage(0)
      return
    }

    // 同章内的重新分页：按当前位置换算成新的页码，别把读者拽回开头
    const current = ratioRef.current
    if (current > 0.005) {
      setPage(Math.max(0, Math.min(screens - 1, Math.round(current * screens))))
    } else {
      setPage(0)
    }
  }, [mode, columnWidth, columns, html, chapterIndex, readerSettings?.fontSize, readerSettings?.lineHeight, bodySize.width])

  /* ---------- 换章时把滚动位置复位（否则新章会停在末尾，看起来像卡住） ---------- */
  const lastChapter = useRef<number | null>(null)
  // 换书时先作废标记，交给「恢复上次位置」处理
  useEffect(() => {
    lastChapter.current = null
  }, [bookId])
  useEffect(() => {
    if (mode !== 'scroll' || !html) return
    if (lastChapter.current === chapterIndex) return
    const first = lastChapter.current === null
    lastChapter.current = chapterIndex
    if (first) return // 首次进入交给「恢复上次位置」处理
    const el = bodyRef.current
    if (el) el.scrollTop = 0
    ratioRef.current = 0
    setRatio(0)
  }, [chapterIndex, mode, html])

  /* ---------- 恢复上次位置 ---------- */
  useEffect(() => {
    if (!bookId || !html) return
    if (restoredBook.current === bookId) return
    restoredBook.current = bookId
    const saved = reader.scrollRatio
    if (saved <= 0.01) return
    if (mode === 'scroll') {
      const el = bodyRef.current
      if (el) {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * saved
        ratioRef.current = saved
        setRatio(saved)
      }
    } else {
      setPage(Math.max(0, Math.min(pages - 1, Math.round(saved * pages))))
    }
  }, [bookId, html, mode, pages, reader.scrollRatio])

  /* ---------- 翻页 ---------- */
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

  const turnRef = useRef(turn)
  turnRef.current = turn

  /* ---------- 手机：左右滑动翻页（点击两侧已有，滑动更合手机习惯） ---------- */
  useEffect(() => {
    const el = bodyRef.current
    if (!el || mode !== 'paged' || !('ontouchstart' in window)) return
    let startX = 0
    let startY = 0
    const onStart = (event: TouchEvent): void => {
      startX = event.touches[0]?.clientX ?? 0
      startY = event.touches[0]?.clientY ?? 0
    }
    const onEnd = (event: TouchEvent): void => {
      const touch = event.changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      // 横向位移够大、且明显大于纵向，才算翻页（否则是滚动或选字）
      if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.2) return
      turnRef.current(dx < 0 ? 1 : -1)
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend', onEnd)
    }
  }, [mode])

  /* ---------- 鼠标滚轮翻页 ---------- */
  useEffect(() => {
    const el = bodyRef.current
    if (!el || mode !== 'paged') return
    let lock = 0
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) < 6) return
      e.preventDefault()
      const now = Date.now()
      if (now < lock) return
      lock = now + WHEEL_LOCK
      turnRef.current(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [mode, html])

  /* ---------- 键盘 ---------- */
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

  /* ---------- 正文内链跳转 ---------- */
  const scrollToAnchor = useCallback((fragment: string) => {
    if (!fragment) return
    const container = bodyRef.current
    if (!container) return
    const target =
      container.querySelector(`[id="${fragment}"]`) ?? container.querySelector(`[name="${fragment}"]`)
    if (target) target.scrollIntoView({ block: 'start' })
  }, [])

  useEffect(() => {
    if (!html) return
    const fragment = pendingAnchor.current
    if (!fragment) return
    pendingAnchor.current = null
    if (mode === 'scroll') window.requestAnimationFrame(() => scrollToAnchor(fragment))
  }, [html, mode, scrollToAnchor])

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!href.startsWith('#epub:')) return
      e.preventDefault()
      e.stopPropagation()

      const rest = href.slice('#epub:'.length)
      const hashIndex = rest.indexOf('#')
      const rawPath = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest
      const fragment = hashIndex >= 0 ? rest.slice(hashIndex + 1) : ''
      let path = rawPath
      try {
        path = decodeURIComponent(rawPath)
      } catch {
        /* 保留原值 */
      }

      const index = chapters.findIndex((chapter) => chapter.href === path)
      if (index < 0) {
        toast('info', '该链接指向的内容不在本书章节中')
        return
      }
      if (index === chapterIndex && fragment) {
        scrollToAnchor(fragment)
        return
      }
      pendingAnchor.current = fragment || null
      void goToChapter(index)
    },
    [chapters, chapterIndex, goToChapter, scrollToAnchor, toast]
  )

  /* ---------- 点击左右区域翻页；面板打开时点击正文先关面板 ---------- */
  const handleBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('a, button, select, input, label')) return
      if (panel !== 'none') {
        setPanel('none')
        return
      }
      if (mode !== 'paged') return
      const rect = e.currentTarget.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      if (x <= TAP_ZONE) turn(-1)
      else if (x >= 1 - TAP_ZONE) turn(1)
    },
    [mode, panel, turn]
  )

  /* ---------- 底部进度条：拖动定位（章内） ---------- */
  const barRef = useRef<HTMLDivElement>(null)
  const dragSeek = useCallback(
    (clientX: number) => {
      const el = barRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const value = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      if (mode === 'paged') {
        const target = Math.min(Math.max(0, pages - 1), Math.round(value * Math.max(0, pages - 1)))
        setPage(target)
        ratioRef.current = pages > 1 ? target / pages : 0
        setRatio(ratioRef.current)
        schedulePersist(ratioRef.current)
        return
      }
      const body = bodyRef.current
      if (!body) return
      const max = body.scrollHeight - body.clientHeight
      const next = max * value
      body.scrollTop = next
      ratioRef.current = max > 8 ? next / max : 0
      setRatio(ratioRef.current)
      schedulePersist(ratioRef.current)
    },
    [mode, pages, schedulePersist]
  )

  const onBarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragSeek(e.clientX)
      const onMove = (ev: MouseEvent): void => dragSeek(ev.clientX)
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [dragSeek]
  )

  const totalPercent = bookPercent(book, chapterIndex, ratio)
  const chapterRatio = mode === 'paged' ? (pages > 1 ? page / pages : 0) : ratio

  const readerStyle = useMemo(
    () =>
      ({
        '--reader-bg': theme.bg,
        '--reader-text': theme.text,
        '--reader-quote': theme.quote,
        '--reader-width': `${readerSettings?.pageWidth ?? 720}px`,
        '--reader-padding': `${padding}px`,
        '--reader-size': `${readerSettings?.fontSize ?? 18}px`,
        '--reader-lh': String(readerSettings?.lineHeight ?? 1.9),
        '--reader-font': FONT_STACKS[(readerSettings?.fontFamily ?? 'system') as FontKey].css,
        // 翻页模式下单栏可用高度，供竖长图限高使用（减去上下内边距）
        '--reader-col-height': `${Math.max(240, bodySize.height - 58)}px`,
        ...(settings?.appearance.readerBackgroundImage
          ? {
              backgroundImage: `linear-gradient(${theme.bg}cc, ${theme.bg}cc), url("${mediaUrl(
                settings.appearance.readerBackgroundImage
              )}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }
          : {})
      }) as React.CSSProperties,
    [theme, padding, readerSettings, settings, bodySize.height]
  )

  if (!book) {
    return (
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
              width: `${screenWidth}px`,
              maxWidth: 'none',
              columnWidth: `${columnWidth}px`,
              columnGap: `${COLUMN_GAP}px`,
              columnFill: 'auto',
              transform: `translateX(-${page * step}px)`
            }
          : undefined
      }
      onClick={handleContentClick}
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
      <div
        className="reader-bar"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) setPanel('none')
        }}
      >
        <button className="icon-btn sm" onClick={closeReader} title="返回书库">
          <ArrowLeft size={18} />
        </button>
        <span className="reader-bar-title">{book.title}</span>
        <span className="reader-bar-sub">
          {chapterIndex + 1}/{chapters.length} · {reader.chapterLabel}
        </span>
        <div className="reader-chapter-switch">
          <button
            className="icon-btn sm"
            title="上一章"
            disabled={chapterIndex === 0}
            onClick={() => void goToChapter(chapterIndex - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-btn sm"
            title="下一章"
            disabled={chapterIndex >= chapters.length - 1}
            onClick={() => void goToChapter(chapterIndex + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="reader-spacer" />
        {mode === 'paged' ? (
          <span className="reader-bar-sub">
            {page + 1}/{pages}
          </span>
        ) : null}
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
        ref={attachBody}
        onClick={handleBodyClick}
      >
        {loading && !html ? (
          <div className="reader-loading">正在解析章节…</div>
        ) : mode === 'paged' ? (
          <div className="reader-viewport" style={{ width: `${screenWidth}px` }}>
            {pageContent}
          </div>
        ) : (
          pageContent
        )}
      </div>

      <div
        className="reader-foot"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('button')) setPanel('none')
        }}
      >
        <button className="icon-btn sm" onClick={() => turn(-1)} title="上一页">
          <ChevronLeft size={17} />
        </button>
        <span className="reader-foot-pct">本章 {percentText(chapterRatio)}%</span>
        <div className="reader-progress" ref={barRef} onMouseDown={onBarMouseDown} title="按住拖动可快速定位">
          <i style={{ width: `${percentText(chapterRatio)}%` }} />
          <span className="reader-progress-knob" style={{ left: `${percentText(chapterRatio)}%` }} />
        </div>
        <span className="reader-foot-pct whole">全书 {percentText(totalPercent)}%</span>
        {mode === 'paged' ? (
          <span className="reader-hint">
            {'ontouchstart' in window ? '左右滑动或点击两侧翻页' : '点击两侧或滚动滚轮翻页'}
          </span>
        ) : null}
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
                <span>版心宽度</span>
                <span className="range-value">{readerSettings?.pageWidth ?? 720} px</span>
              </div>
              <Slider
                value={readerSettings?.pageWidth ?? 720}
                min={480}
                max={920}
                step={20}
                onChange={(v) => void saveSettings({ reader: { ...readerSettings!, pageWidth: v } })}
              />
            </div>
            <div className="panel-row">
              <div className="panel-row-title">
                <span>页边距</span>
                <span className="range-value">{padding} px</span>
              </div>
              <Slider
                value={padding}
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
              <div className="setting-hint" style={{ marginTop: 8 }}>
                {mode === 'paged'
                  ? `当前 ${columns} 栏显示，点击页面左右两侧或滚动滚轮翻页`
                  : '上下滚动阅读'}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
