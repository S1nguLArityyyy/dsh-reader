import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Info, List, Type } from 'lucide-react'
import type { ReaderTheme } from '@shared/types'
import { bookPercent, useApp } from '../store/app'
import { FONT_STACKS, READER_THEMES, type FontKey } from '../lib/reader-theme'
import { mediaUrl, percentText } from '../lib/format'
import {
  applyScrollRatio,
  currentExcerpt,
  excerptMatches,
  pagedRatio,
  scrollRatioOf
} from '../lib/bookmark-anchor'
import { BookmarkButton } from '../components/BookmarkButton'
import { AnnotationToolbar, type AnnotationToolbarTarget } from '../components/AnnotationToolbar'
import { anchorRange, selectionAnchor } from '../lib/annotation-anchor'
import { planForSelection, tokenizeHtml } from '@shared/annotations'
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
  /**
   * 本书每章读到哪（章号 → 章内比例）。
   * 向前翻回上一章时要回到"那一章上次读到的位置"，
   * 而 progress 里只存了"当前章"的位置 —— 所以这里按章号记一份。
   */
  const chapterPositions = useRef<Record<number, number>>({})
  /** 从书签跳进来时的定位信息，配一次就清掉 */
  const jumpTarget = useRef<{ ratio: number; excerpt: string } | null>(null)
  /** 顶栏书签按钮（Ctrl+B 直接点它） */
  const bookmarkBtnRef = useRef<HTMLButtonElement | null>(null)
  /** 划线 / 笔记的浮动菜单 */
  const [annotTool, setAnnotTool] = useState<AnnotationToolbarTarget | null>(null)

  const readerSettings = settings?.reader
  const theme = READER_THEMES[readerSettings?.theme ?? 'paper']
  const mode = readerSettings?.mode ?? 'scroll'
  const padding = readerSettings?.padding ?? 36
  const { bookId, chapters, chapterIndex, html, loading, book } = reader

  /* ---------- 书签按钮要的两个现场值 ---------- */
  /** 当前位置（章内比例）：翻页模式取当前屏，滚动模式取滚动比例 */
  const bookmarkRatio = useCallback(
    (): number => (mode === 'paged' ? pagedRatio(page, pages) : scrollRatioOf(bodyRef.current)),
    [mode, page, pages]
  )
  const bookmarkExcerpt = useCallback(
    (): string => currentExcerpt(bodyRef.current, mode),
    [mode]
  )

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

    // ★ 换章要重新定位，但切模式 / 改排版 / 缩放窗口不能 ★
    //   之前这里无条件 setPage(0) + ratio=0，于是"阅读中切滚动↔翻页"会跳回本章开头（用户反馈的 bug）
    if (pagedChapter.current !== chapterIndex) {
      pagedChapter.current = chapterIndex
      const toRatio = (value: number): void => {
        ratioRef.current = value
        setRatio(value)
      }
      if (reader.jumpDir === 'resume') {
        // 按章翻阅回到这一章：落在【上次读到的位置】，而不是开头或末尾
        const saved = Math.min(0.999, Math.max(0, reader.restoreRatio ?? 0))
        setPage(Math.max(0, Math.min(screens - 1, Math.round(saved * screens))))
        toRatio(saved)
        return
      }
      if (reader.jumpDir === 'backward') {
        // 向前翻过了章首、且这一章没有阅读记录：停在它的最后一屏
        const last = screens - 1
        setPage(last)
        toRatio(screens > 1 ? last / screens : 0)
        return
      }
      toRatio(0)
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
    pagedChapter.current = null
    // 换书：清掉上一本记的"每章读到哪"，避免串到新书上
    chapterPositions.current = {}
  }, [bookId])

  // 进入某一章时把当前位置登记进去：这是"翻回上一章"时的落点依据
  useEffect(() => {
    if (!html) return
    chapterPositions.current[chapterIndex] = ratioRef.current
  }, [html, chapterIndex])
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
    const saved = reader.scrollRatio
    if (saved <= 0.01) {
      restoredBook.current = bookId
      return
    }

    // 滚动模式：容器高度一就绪就能定位
    if (mode === 'scroll') {
      if (restoredBook.current === bookId) return
      const el = bodyRef.current
      if (!el || el.clientHeight === 0) return // 还没量到高度，等下一轮
      restoredBook.current = bookId
      el.scrollTop = (el.scrollHeight - el.clientHeight) * saved
      ratioRef.current = saved
      setRatio(saved)
      return
    }

    // 翻页模式：必须等分页数算出来再定位。
    // 此前在 html 一就绪就 setPage(saved * pages)，而那时 pages 还是初始值 1，
    // 乘出来是 0 —— 于是重新打开总是回到本章开头。
    // 这里不设一次性守卫，pages 变化时会重算一次，setPage 对同值不会再触发渲染。
    if (bodySize.width <= 0 || pages <= 0) return
    restoredBook.current = bookId
    ratioRef.current = saved
    setRatio(saved)
    setPage(Math.max(0, Math.min(pages - 1, Math.round(saved * pages))))
  }, [bookId, html, mode, pages, reader.scrollRatio, bodySize.width])

  /* ---------- 从书签跳进来：定位到书签所在位置 ---------- */
  useEffect(() => {
    const anchor = reader.bookmarkAnchor
    if (!anchor) return
    if (!html || loading) return
    jumpTarget.current = { ratio: anchor.scrollRatio, excerpt: anchor.excerpt ?? '' }
    lastChapter.current = chapterIndex
    if (mode === 'scroll') {
      const el = bodyRef.current
      if (!el) return
      applyScrollRatio(el, anchor.scrollRatio)
      ratioRef.current = anchor.scrollRatio
      setRatio(anchor.scrollRatio)
      // 摘录对不上（换过排版或书改过）时只记一笔，位置仍按比例走
      if (anchor.excerpt && !excerptMatches(anchor.excerpt, currentExcerpt(el, mode))) {
        jumpTarget.current = null
      }
    } else {
      ratioRef.current = anchor.scrollRatio
      setRatio(anchor.scrollRatio)
      if (pages > 1) setPage(Math.min(pages - 1, Math.round(anchor.scrollRatio * pages)))
    }
    restoredBook.current = bookId
    useApp.setState({ reader: { ...useApp.getState().reader, bookmarkAnchor: null } })
  }, [bookId, html, loading, chapterIndex, mode, pages, reader.bookmarkAnchor])

  /* ---------- 划线 / 笔记：选中正文后弹出浮动菜单 ---------- */

  /** DOM 视口坐标 → 相对正文容器坐标 */
  const toContainerPoint = useCallback((x: number, y: number): { left: number; top: number } => {
    const host = bodyRef.current
    if (!host) return { left: x, top: y }
    const rect = host.getBoundingClientRect()
    return { left: x - rect.left + host.scrollLeft, top: y - rect.top + host.scrollTop }
  }, [])

  /** 打开菜单（新选区或点已有的划线） */
  const openAnnotationTool = useCallback(
    (
      anchor: AnnotationToolbarTarget['anchor'],
      quote: string,
      rect: { left: number; right: number; top: number },
      existing?: { id: string; color: AnnotationToolbarTarget['color']; style: AnnotationToolbarTarget['style']; note: string },
      covered?: AnnotationToolbarTarget['covered']
    ) => {
      const point = toContainerPoint((rect.left + rect.right) / 2, rect.top)
      setAnnotTool({
        id: existing?.id ?? null,
        color: existing?.color ?? 'yellow',
        style: existing?.style ?? 'highlight',
        note: existing?.note ?? '',
        anchor,
        quote,
        covered,
        left: Math.max(150, point.left),
        top: Math.max(44, point.top - 8)
      })
    },
    [toContainerPoint]
  )

  /** 鼠标松开：有选区就弹菜单 */
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    const onUp = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return
      const page = host.querySelector('.reader-page')
      if (!page) return
      const anchor = selectionAnchor(page, selection)
      if (!anchor) return
      const range = selection.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return

      // 这次选区盖住了哪些已有标注：划线时要先把它们处理掉，否则会叠色
      const tokens = tokenizeHtml(useApp.getState().reader.html)
      const covered = planForSelection(
        tokens,
        {
          id: '',
          blockIndex: anchor.blockIndex,
          tokenIndex: anchor.tokenIndex,
          startOffset: anchor.start,
          endBlockIndex: anchor.endBlockIndex,
          endTokenIndex: anchor.endTokenIndex,
          endOffset: anchor.end
        },
        useApp
          .getState()
          .annotations.filter(
            (item) => !item.deletedAt && item.bookId === bookId && item.chapterIndex === chapterIndex
          )
      )
      openAnnotationTool(anchor, anchor.quote, rect, undefined, covered)
    }
    host.addEventListener('mouseup', onUp)
    host.addEventListener('touchend', onUp)
    return () => {
      host.removeEventListener('mouseup', onUp)
      host.removeEventListener('touchend', onUp)
    }
  }, [openAnnotationTool, html, mode, bookId, chapterIndex])

  /** 点击已有划线 / 笔记图标：打开菜单 */
  const handleAnnotationClick = useCallback(
    (mark: HTMLElement, e: React.MouseEvent<HTMLDivElement>): boolean => {
      // 点在笔记图标上：直接看笔记内容
      const noteBtn = (e.target as HTMLElement).closest('.ann-note-btn') as HTMLElement | null
      if (noteBtn) {
        e.preventDefault()
        e.stopPropagation()
        const owner = noteBtn.previousElementSibling as HTMLElement | null
        if (owner) openNoteView(owner, noteBtn)
        return true
      }
      const id = mark.dataset.ann ?? ''
      const item = useApp.getState().annotations.find((entry) => entry.id === id)
      const host = bodyRef.current
      const page = host?.querySelector('.reader-page')
      if (!item || !host || !page) return false
      e.preventDefault()
      e.stopPropagation()

      // 把原选区选回去，菜单位置就跟着它
      const range = anchorRange(page, item)
      let rect: { left: number; right: number; top: number } | null = null
      if (range) {
        const box = range.getBoundingClientRect()
        if (box.width > 0 || box.height > 0) {
          rect = { left: box.left, right: box.right, top: box.top }
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
      }
      if (!rect) {
        const box = mark.getBoundingClientRect()
        rect = { left: box.left, right: box.right, top: box.top }
      }
      openAnnotationTool(
        {
          blockIndex: item.blockIndex,
          tokenIndex: item.tokenIndex,
          start: item.startOffset,
          endBlockIndex: item.endBlockIndex,
          endTokenIndex: item.endTokenIndex,
          end: item.endOffset
        },
        item.quote,
        rect,
        { id: item.id, color: item.color, style: item.style, note: item.note }
      )
      return true
    },
    [openAnnotationTool]
  )

  /** 菜单里改颜色 / 改样式：没有标注就先建一条，再更新 */
  const ensureAnnotation = useCallback(
    async (patch?: { color?: AnnotationToolbarTarget['color']; style?: AnnotationToolbarTarget['style']; note?: string }) => {
      const target = annotTool
      const state = useApp.getState()
      const readerState = state.reader
      if (!target || !readerState.bookId) return null
      let id = target.id
      if (!id) {
        /*
         * 落笔前先处理重叠：整段被盖住的删掉，只盖住一部分的裁成剩下的部分。
         * 这里**每次都按当前状态重算**，不能只用选区时缓存的结果 ——
         * 同一段连着换几次颜色时缓存第一次就用掉了，后面几次会叠上去。
         */
        const tokens = tokenizeHtml(readerState.html)
        const plan = planForSelection(
          tokens,
          {
            id: '',
            blockIndex: target.anchor.blockIndex,
            tokenIndex: target.anchor.tokenIndex,
            startOffset: target.anchor.start,
            endBlockIndex: target.anchor.endBlockIndex,
            endTokenIndex: target.anchor.endTokenIndex,
            endOffset: target.anchor.end
          },
          state.annotations.filter((item) => !item.deletedAt && item.bookId === readerState.bookId)
        )
        for (const removeId of plan.remove) await state.removeAnnotation(removeId)
        for (const piece of plan.trim) {
          await state.updateAnnotation(piece.id, {
            blockIndex: piece.blockIndex,
            tokenIndex: piece.tokenIndex,
            startOffset: piece.startOffset,
            endBlockIndex: piece.endBlockIndex,
            endTokenIndex: piece.endTokenIndex,
            endOffset: piece.endOffset,
            quote: piece.quote
          })
        }

        const created = await state.addAnnotation({
          bookId: readerState.bookId,
          chapterIndex: readerState.chapterIndex,
          chapterTitle: readerState.chapterLabel,
          blockIndex: target.anchor.blockIndex,
          tokenIndex: target.anchor.tokenIndex,
          startOffset: target.anchor.start,
          endBlockIndex: target.anchor.endBlockIndex,
          endTokenIndex: target.anchor.endTokenIndex,
          endOffset: target.anchor.end,
          quote: target.quote,
          note: patch?.note ?? '',
          color: patch?.color ?? target.color,
          style: patch?.style ?? target.style
        })
        if (!created) return null
        id = created.id
        setAnnotTool({ ...target, covered: undefined, id, color: created.color, style: created.style, note: created.note })
        return created
      }
      await state.updateAnnotation(id, patch ?? {})
      return id
    },
    [annotTool]
  )

  const pickColor = useCallback(
    (color: AnnotationToolbarTarget['color']) => {
      setAnnotTool((prev) => (prev ? { ...prev, color } : prev))
      void ensureAnnotation({ color })
    },
    [ensureAnnotation]
  )

  const pickStyle = useCallback(
    (style: AnnotationToolbarTarget['style']) => {
      setAnnotTool((prev) => (prev ? { ...prev, style } : prev))
      void ensureAnnotation({ style })
    },
    [ensureAnnotation]
  )

  const saveNote = useCallback(
    (note: string) => {
      setAnnotTool((prev) => (prev ? { ...prev, note, noteIntent: true, viewNote: false } : prev))
      void ensureAnnotation({ note })
    },
    [ensureAnnotation]
  )

  const deleteAnnotation = useCallback(() => {
    const target = annotTool
    setAnnotTool(null)
    window.getSelection()?.removeAllRanges()
    if (target?.id) void useApp.getState().removeAnnotation(target.id)
  }, [annotTool])

  const closeAnnotationTool = useCallback(() => {
    setAnnotTool(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  /** 换章 / 改排版后旧坐标失效，关掉菜单 */
  useEffect(() => {
    setAnnotTool(null)
  }, [chapterIndex, html])

  /*
   * 标注一变就重新取本章 HTML。
   * 主进程在 reader:chapter 里把这一章的划线包成 <mark>，不重取的话界面上看不到刚划的线。
   * 用签名对比，避免「重取 → html 变 → 再重取」转圈。
   */
  const annotations = useApp((s) => s.annotations)
  const reloadChapter = useApp((s) => s.reloadChapter)
  const loadedAnnotationSig = useRef<string | null>(null)
  /** 因为「正在输入备注」而被推后的章节刷新 */
  const pendingChapterReload = useRef(false)
  useEffect(() => {
    const list = annotations.filter((item) => item.bookId === bookId && item.chapterIndex === chapterIndex)
    const signature = list
      .map((item) => `${item.id}:${item.color}:${item.style}:${item.note ? 1 : 0}:${item.deletedAt ? 'x' : ''}`)
      .sort()
      .join('|')
    if (loadedAnnotationSig.current === null) {
      loadedAnnotationSig.current = signature
      return
    }
    if (loadedAnnotationSig.current === signature) return
    loadedAnnotationSig.current = signature
    /*
     * 只有「DOM 里的标记集合与当前标注集合完全一致」才跳过重取。
     * 只判断「标记都在」是不够的：删掉一条之后，剩下的标记仍然都在 DOM 里，
     * 于是不会重取，页面上就会继续显示那条已经删掉的线。
     */
    const active = list.filter((item) => !item.deletedAt)
    const inDom = new Set(
      Array.from(bodyRef.current?.querySelectorAll('mark.ann[data-ann]') ?? []).map(
        (el) => (el as HTMLElement).dataset.ann ?? ''
      )
    )
    const sameSet = active.length === inDom.size && active.every((item) => inDom.has(item.id))
    if (sameSet) return
    // 用户正在备注框里打字：此刻换掉整章 DOM 会把输入框卸载，字就丢了。
    // 记下来，等他离开输入框再刷新。
    if (document.activeElement?.classList.contains('ann-note-pop-ta')) {
      pendingChapterReload.current = true
      return
    }
    void reloadChapter()
  }, [annotations, bookId, chapterIndex, reloadChapter])

  /** 备注框失焦 / 关闭后，把刚才推后的章节刷新补上 */
  useEffect(() => {
    const onFocusOut = (): void => {
      if (!pendingChapterReload.current) return
      pendingChapterReload.current = false
      window.setTimeout(() => {
        if (!document.activeElement?.classList.contains('ann-note-pop-ta')) void useApp.getState().reloadChapter()
      }, 120)
    }
    document.addEventListener('focusout', onFocusOut, true)
    return () => document.removeEventListener('focusout', onFocusOut, true)
  }, [])

  /* ---------- 从阅读记录跳进来：选中那条划线并滚动到它 ---------- */
  useEffect(() => {
    const target = reader.annotationAnchor
    if (!target) return
    if (!html || loading) return
    const host = bodyRef.current
    const page = host?.querySelector('.reader-page')
    if (!host || !page) return
    const range = anchorRange(page, target)
    if (!range) {
      useApp.setState({ reader: { ...useApp.getState().reader, annotationAnchor: null } })
      return
    }
    const mark = range.startContainer.parentElement?.closest('mark.ann') as HTMLElement | null
    const box = range.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    // 滚到可视区中间附近
    const delta = box.top - hostRect.top - host.clientHeight * 0.35
    if (Math.abs(delta) > 40) host.scrollBy({ top: delta, behavior: 'auto' })
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    if (mark) {
      setAnnotTool({
        id: mark.dataset.ann ?? null,
        color: (mark.className.match(/ann-(yellow|green|blue|pink|purple)/)?.[1] ?? 'yellow') as AnnotationToolbarTarget['color'],
        style: mark.className.includes('ann-underline') ? 'underline' : 'highlight',
        note: useApp.getState().annotations.find((item) => item.id === mark.dataset.ann)?.note ?? '',
        anchor: {
          blockIndex: target.blockIndex,
          tokenIndex: target.tokenIndex,
          start: target.start,
          endBlockIndex: target.endBlockIndex,
          endTokenIndex: target.endTokenIndex,
          end: target.end
        },
        quote: useApp.getState().annotations.find((item) => item.id === mark.dataset.ann)?.quote ?? '',
        left: Math.max(150, box.left - hostRect.left + box.width / 2),
        top: Math.max(44, box.top - hostRect.top - 8)
      })
    }
    useApp.setState({ reader: { ...useApp.getState().reader, annotationAnchor: null } })
  }, [html, loading, reader.annotationAnchor])

  /* ---------- 笔记：在划线末尾放一个可点的图标，点开看内容 ---------- */

  /** 有笔记的标注在正文末尾插一个小图标（主进程注入的 <mark> 只带 data-note） */
  const decorateNotes = useCallback(() => {
    const host = bodyRef.current
    const page = host?.querySelector('.reader-page')
    if (!host || !page) return
    for (const mark of Array.from(page.querySelectorAll('mark.ann[data-note="1"]'))) {
      if (mark.nextElementSibling?.classList.contains('ann-note-btn')) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ann-note-btn'
      button.dataset.noteFor = (mark as HTMLElement).dataset.ann ?? ''
      button.title = '查看笔记'
      button.innerHTML =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
      mark.insertAdjacentElement('afterend', button)
    }
  }, [])

  useEffect(() => {
    decorateNotes()
  }, [decorateNotes, html, chapterIndex, mode])

  /** 点笔记图标：给标注菜单换成「看笔记」模式 */
  const openNoteView = useCallback((mark: HTMLElement, button: HTMLElement) => {
    const id = button.dataset.noteFor ?? mark.dataset.ann ?? ''
    const item = useApp.getState().annotations.find((entry) => entry.id === id)
    const host = bodyRef.current
    if (!item || !host) return
    const hostRect = host.getBoundingClientRect()
    const box = mark.getBoundingClientRect()
    setAnnotTool({
      id: item.id,
      color: item.color,
      style: item.style,
      note: item.note,
      anchor: {
        blockIndex: item.blockIndex,
        tokenIndex: item.tokenIndex,
        start: item.startOffset,
        endBlockIndex: item.endBlockIndex,
        endTokenIndex: item.endTokenIndex,
        end: item.endOffset
      },
      quote: item.quote,
      viewNote: true,
      left: Math.max(150, box.left - hostRect.left + box.width / 2),
      top: Math.max(44, box.top - hostRect.top - 8)
    })
  }, [])

  /* ---------- 翻页 ---------- */
  const turn = useCallback(
    (delta: number) => {
      if (mode === 'paged') {
        const next = page + delta
        if (next < 0) {
          // 向前翻过章首：回到上一章【上次读到的位置】
          chapterPositions.current[chapterIndex] = ratioRef.current
          persist(ratioRef.current)
          if (chapterIndex > 0) {
            void goToChapter(chapterIndex - 1, 'backward', { positions: chapterPositions.current })
          }
          return
        }
        if (next >= pages) {
          chapterPositions.current[chapterIndex] = ratioRef.current
          persist(ratioRef.current)
          if (chapterIndex < chapters.length - 1) void goToChapter(chapterIndex + 1, 'forward')
          return
        }
        setPage(next)
        const value = pages > 1 ? next / pages : 0
        ratioRef.current = value
        // 随手记下本章读到哪，翻回去时要用
        chapterPositions.current[chapterIndex] = value
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
      // 焦点在输入框里时（书签备注）不要翻页
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        bookmarkBtnRef.current?.click()
        return
      }
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
      // 点在已有划线上：打开它的菜单（改色 / 改样式 / 写备注）
      const mark = (e.target as HTMLElement).closest('mark.ann') as HTMLElement | null
      if (mark && handleAnnotationClick(mark, e)) return

      if ((e.target as HTMLElement).closest('a, button, select, input, label')) return

      // 刚划完字（或点过划线）不要顺手翻页
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && (selection.toString() ?? '').trim().length > 0) return

      if (panel !== 'none') {
        setPanel('none')
        return
      }
      if (annotTool) {
        closeAnnotationTool()
        return
      }
      if (mode !== 'paged') return
      const rect = e.currentTarget.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      if (x <= TAP_ZONE) turn(-1)
      else if (x >= 1 - TAP_ZONE) turn(1)
    },
    [mode, panel, turn, annotTool, closeAnnotationTool, handleAnnotationClick]
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
      {annotTool ? (
        <AnnotationToolbar
          target={annotTool}
          noteMax={500}
          onPickColor={pickColor}
          onPickStyle={pickStyle}
          onSaveNote={saveNote}
          onDelete={deleteAnnotation}
          onClose={closeAnnotationTool}
        />
      ) : null}
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
        <BookmarkButton
          buttonRef={bookmarkBtnRef}
          chapterIndex={chapterIndex}
          chapterTitle={reader.chapterLabel}
          currentRatio={bookmarkRatio}
          currentExcerpt={bookmarkExcerpt}
          disabled={loading && !html}
        />
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
