import { create } from 'zustand'
import { percentByPosition } from '@shared/progress'
import { activeBookmarks, findBookmarkAt } from '@shared/bookmarks'
import type { BookmarkInput } from '@shared/bookmarks'
import type { AnnotationInput, AnnotationPatch } from '@shared/types'
import type {
  Annotation,
  AppInfo,
  Book,
  Bookmark,
  ChapterRef,
  LanConflictItem,
  Settings,
  StatsPayload,
  TocEntry
} from '@shared/types'

export type Route = 'library' | 'stats' | 'bookmarks' | 'records' | 'settings' | 'reader'

export interface ToastItem {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  /** 可选的操作按钮（例如删除书签后的「撤销」） */
  action?: { label: string; run: () => void }
}

/** 从书签跳回阅读器时的目标位置 */
export interface BookmarkAnchor {
  chapterIndex: number
  scrollRatio: number
  excerpt?: string
}

/** 从阅读记录跳回阅读器时，要定位并选中的那条划线 */
export interface AnnotationAnchor {
  chapterIndex: number
  blockIndex: number
  tokenIndex: number
  start: number
  endBlockIndex: number
  endTokenIndex: number
  end: number
}

export interface ReaderState {
  bookId: string | null
  book: Book | null
  toc: TocEntry[]
  chapters: ChapterRef[]
  chapterIndex: number
  chapterLabel: string
  html: string
  loading: boolean
  error: string | null
  /** 打开时恢复用的滚动比例 */
  scrollRatio: number
  /** 从书签跳进来时的目标位置（用一次就清掉） */
  bookmarkAnchor: BookmarkAnchor | null
  /** 从阅读记录跳进来时要定位的那条划线（用一次就清掉） */
  annotationAnchor: AnnotationAnchor | null
  /**
   * 最近一次换章的方向：
   *  - forward：向后翻过章末（落在新章开头）
   *  - backward：向前翻过章首（该章没有记录时落到末尾）
   *  - resume：回到该章上次读到的位置
   */
  jumpDir?: 'forward' | 'backward' | 'resume'
  /** jumpDir === 'resume' 时要恢复到的章内位置（0~1） */
  restoreRatio?: number
}

const emptyReader: ReaderState = {
  bookId: null,
  book: null,
  toc: [],
  chapters: [],
  chapterIndex: 0,
  chapterLabel: '',
  html: '',
  loading: false,
  error: null,
  scrollRatio: 0,
  bookmarkAnchor: null,
  annotationAnchor: null,
  jumpDir: 'forward'
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 没有历史进度时选择起始章节：
 * 跳过封面/制作/版权等前置页，从正文第一项开始。
 */
  /^(封面|书封|書封|封底|书名|書名|标题|標題|制作|製作|版权|版權|版权页|版權頁|声明|聲明|免责|免責|录入|錄入|下载|下載|简介|簡介|内容简介|作品简介|目录|目次|目錄|信息|資訊|彩插|彩頁|彩页|插图|插圖|扉页|扉頁|奥付|翻译|翻譯|汉化|漢化|制作信息)/

/**
 * 决定"从哪一章开始读"（仅用于没有阅读记录的新书）。
 * 旧实现挑"第一个不像前置页的条目"，会猜过头，一本没开过的书直接停在第十章左右。
 * 现在保守：只有明确是封面/目录/版权这类非正文条目才往后跳，其余一律从第 0 章开始。
 */
function pickStartChapter(payload: { toc: { label: string; chapterIndex: number }[] }): number {
  const skip = /^(封面|书名|目录|目次|版权|扉页|插页|广告|contents?|cover|title)/i
  for (const item of payload.toc ?? []) {
    const label = String(item.label ?? "").trim()
    if (label && !skip.test(label)) return item.chapterIndex
  }
  return 0
}

/**
 * 整书进度：按「读到的位置」计算，而不是章节序号。
 * 没有字数数据时退回按章节序号估算。
 */
export function bookPercent(book: Book | null, chapterIndex: number, scrollRatio: number): number {
  if (!book) return 0
  const chars = book.chapterChars ?? []
  const total = book.wordCount > 0 ? book.wordCount : chars.reduce((sum, n) => sum + n, 0)
  if (chars.length === 0 || total <= 0) {
    const count = Math.max(1, book.chapterCount || 1)
    return Math.min(1, Math.max(0, (chapterIndex + scrollRatio) / count))
  }
  return percentByPosition(chars, total, chapterIndex, scrollRatio)
}

interface AppStore {
  ready: boolean
  route: Route
  info: AppInfo | null
  books: Book[]
  settings: Settings | null
  stats: StatsPayload | null
  toasts: ToastItem[]
  reader: ReaderState
  /** 书籍详情弹窗 */
  detailBookId: string | null
  /** 手机推来的记录与电脑端冲突、等待裁决的那些 */
  lanConflicts: LanConflictItem[]
  /** 裁决弹窗是否打开 */
  lanConflictOpen: boolean
  /** 用户当前的选择：bookId → 采用哪一边 */
  lanChoices: Record<string, 'desktop' | 'phone'>
  /** 书库筛选：null=全部，'__singles__'=单册，其它=系列名 */
  seriesFilter: string | null
  /** 侧边栏系列二级菜单是否展开 */
  seriesOpen: boolean
  /** 书库搜索词（匹配书名 / 作者 / 系列） */
  search: string
  /** 多选管理模式 */
  selectMode: boolean
  selected: string[]

  /** 书签：全部（未删除的）与上限提示用的剩余额度 */
  bookmarks: Bookmark[]
  bookmarkRemaining: number
  /** 书签页当前选中的书（右栏只显示它的书签） */
  bookmarkBookId: string | null
  bookmarkSort: 'recent' | 'chapter'

  /** 划线 / 笔记：全部（未删除的） */
  annotations: Annotation[]
  /** 阅读记录页当前选中的书 */
  recordBookId: string | null
  /** 阅读记录页筛选：全部 / 只看划线 / 只看笔记 */
  recordFilter: 'all' | 'highlight' | 'note'

  init: () => Promise<void>
  go: (route: Route) => void
  toast: (kind: ToastItem['kind'], text: string, action?: ToastItem['action']) => void
  dismissToast: (id: number) => void
  openDetail: (bookId: string) => void
  closeDetail: () => void
  /** 拉取待裁决的冲突（有则自动弹窗） */
  loadLanConflicts: () => Promise<void>
  setLanConflictOpen: (open: boolean) => void
  chooseLanConflict: (bookId: string, choice: 'desktop' | 'phone') => void
  chooseAllLanConflicts: (choice: 'desktop' | 'phone') => void
  resolveLanConflicts: () => Promise<void>
  setSeriesFilter: (key: string | null) => void
  toggleSeries: () => void
  setSearch: (value: string) => void
  toggleSelectMode: () => void
  toggleSelected: (bookId: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  bulkRemove: (deleteFile: boolean) => Promise<void>
  bulkHide: () => Promise<void>
  setManualSeries: (ids: string[], name: string | null) => Promise<void>

  loadBooks: () => Promise<void>
  loadStats: () => Promise<void>
  refreshAll: () => Promise<void>

  importDialog: () => Promise<void>
  importFolderDialog: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  removeBook: (id: string, deleteFile: boolean) => Promise<void>
  updateBook: (id: string, patch: Partial<Book>) => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>

  openReader: (bookId: string, anchor?: BookmarkAnchor) => Promise<void>
  closeReader: () => void
  goToChapter: (
    index: number,
    dir?: 'forward' | 'backward',
    resume?: { positions?: Record<number, number> }
  ) => Promise<void>

  /** 书签 */
  loadBookmarks: () => Promise<void>
  refreshBookmarkRemaining: (bookId: string) => Promise<void>
  setBookmarkBook: (bookId: string | null) => void
  setBookmarkSort: (sort: 'recent' | 'chapter') => void
  addBookmark: (input: BookmarkInput) => Promise<Bookmark | null>
  updateBookmark: (id: string, patch: { note?: string; scrollRatio?: number; excerpt?: string }) => Promise<void>
  removeBookmark: (id: string) => Promise<void>

  /** 划线 / 笔记 */
  loadAnnotations: () => Promise<void>
  setRecordBook: (bookId: string | null) => void
  setRecordFilter: (filter: 'all' | 'highlight' | 'note') => void
  annotationsOf: (bookId: string) => Annotation[]
  addAnnotation: (input: AnnotationInput) => Promise<Annotation | null>
  updateAnnotation: (id: string, patch: AnnotationPatch) => Promise<void>
  removeAnnotation: (id: string) => Promise<void>
  /** 打开某条标注所在的章节并定位（阅读记录页跳转用） */
  openAnnotation: (annotation: Annotation) => Promise<void>
  /** 标注变化后重新取当前章 HTML（主进程会把 <mark> 注入进去） */
  reloadChapter: () => Promise<void>
}

let toastSeq = 0

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  route: 'library',
  info: null,
  books: [],
  settings: null,
  stats: null,
  toasts: [],
  reader: { ...emptyReader },
  detailBookId: null,
  lanConflicts: [],
  lanConflictOpen: false,
  lanChoices: {},
  seriesFilter: null,
  seriesOpen: true,
  search: '',
  selectMode: false,
  selected: [],
  bookmarks: [],
  bookmarkRemaining: 99,
  bookmarkBookId: null,
  bookmarkSort: 'recent',
  annotations: [],
  recordBookId: null,
  recordFilter: 'all',

  async init() {
    try {
      const params = new URLSearchParams(window.location.search)
      const routeParam = (params.get('route') ?? 'library') as Route
      const modal = params.get('modal') ?? ''
      const bookParam = params.get('book') ?? ''

      const [info, settings, books, stats, bookmarks, annotations] = await Promise.all([
        window.api.app.info(),
        window.api.settings.get(),
        window.api.library.list(),
        window.api.stats.get(),
        window.api.bookmarks.list(),
        window.api.annotations.list()
      ])

      set({
        info,
        settings,
        books: [...books].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)),
        stats,
        bookmarks,
        annotations,
        route: routeParam,
        ready: true
      })

      // 手机通过局域网推来记录后，主进程会重读并发这个事件，界面跟着刷新
      if (typeof window.api.lan?.onChanged === 'function') {
        window.api.lan.onChanged(() => {
          void get().refreshAll()
        })
      }

      // 手机推来的记录与电脑端冲突：主进程整批暂缓并通知，这里弹窗请用户裁决
      if (typeof window.api.lan?.onConflict === 'function') {
        window.api.lan.onConflict(() => {
          void get().loadLanConflicts()
        })
      }
      // 启动时可能就有上次没裁决完的
      void get().loadLanConflicts()

      if (modal === 'detail' && books.length > 0) set({ detailBookId: books[0].id })

      // 便于深链 / 截图的状态参数
      const searchParam = params.get('search')
      if (searchParam) set({ search: searchParam })
      if (params.get('select') === '1' && books.length > 0) {
        set({ selectMode: true, selected: books.slice(0, 2).map((book) => book.id) })
      }

      // 主进程补齐旧书信息后会通知刷新
      if (typeof window.api.library.onChanged === 'function') {
        window.api.library.onChanged(() => {
          void get().loadBooks()
        })
      }

      // 同步跑完（含启动后 / 定时 / 退出前的自动同步）后刷新：
      // 书库进度、「今日阅读」显示的是哪本书、统计页数字都可能变了

      if (routeParam === 'reader' && books.length > 0) {
        const target = bookParam && bookParam !== 'first' ? bookParam : books[0].id
        await get().openReader(target)
      }
    } catch (err) {
      set({ ready: true })
      get().toast('error', `初始化失败：${errorText(err)}`)
    }
  },

  go(route) {
    set({ route })
  },

  toast(kind, text, action) {
    toastSeq += 1
    const id = toastSeq
    set({ toasts: [...get().toasts, { id, kind, text, action }] })
    window.setTimeout(() => get().dismissToast(id), action ? 8000 : 4200)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },

  openDetail(bookId) {
    set({ detailBookId: bookId })
  },

  closeDetail() {
    set({ detailBookId: null })
  },

  setSeriesFilter(key) {
    set({ seriesFilter: key, route: 'library' })
  },

  toggleSeries() {
    set({ seriesOpen: !get().seriesOpen })
  },

  setSearch(value) {
    set({ search: value })
  },

  toggleSelectMode() {
    const next = !get().selectMode
    set({ selectMode: next, selected: next ? get().selected : [] })
  },

  toggleSelected(bookId) {
    const selected = get().selected
    set({
      selected: selected.includes(bookId) ? selected.filter((id) => id !== bookId) : [...selected, bookId]
    })
  },

  selectAll(ids) {
    set({ selected: ids })
  },

  clearSelection() {
    set({ selected: [] })
  },

  async bulkRemove(deleteFile) {
    const ids = get().selected
    if (ids.length === 0) return
    const ok = await window.api.dialog.confirm({
      title: deleteFile ? '批量删除' : '批量移出书库',
      message: deleteFile ? `确定删除选中的 ${ids.length} 本书吗？` : `确定把选中的 ${ids.length} 本书移出书库吗？`,
      detail: deleteFile ? '书籍文件与阅读记录都会被删除，此操作不可撤销。' : '仅从书库移除，磁盘上的原文件会保留。',
      confirmText: deleteFile ? '删除' : '移除',
      danger: deleteFile
    })
    if (!ok) return
    for (const id of ids) await window.api.library.remove(id, deleteFile)
    await get().loadBooks()
    await get().loadStats()
    set({ selected: [], selectMode: false })
    get().toast('success', `已处理 ${ids.length} 本书`)
  },

  async bulkHide() {
    const ids = get().selected
    if (ids.length === 0) return
    for (const id of ids) await window.api.library.update(id, { hidden: true })
    await get().loadBooks()
    set({ selected: [], selectMode: false })
    get().toast('success', `已隐藏 ${ids.length} 本书`)
  },

  async setManualSeries(ids, name) {
    if (ids.length === 0) return
    for (const id of ids) await window.api.library.update(id, { manualSeries: name })
    await get().loadBooks()
    get().toast('success', name ? `已归入合集「${name}」` : '已移出合集')
  },

  async loadBooks() {
    const books = await window.api.library.list()
    set({ books: [...books].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)) })
  },

  async loadStats() {
    set({ stats: await window.api.stats.get() })
  },

  async refreshAll() {
    await Promise.all([get().loadBooks(), get().loadStats()])
  },

  async importDialog() {
    try {
      const result = await window.api.library.importDialog()
      await get().loadBooks()
      await get().loadStats()
      if (result.books.length > 0) get().toast('success', `已导入 ${result.books.length} 本书`)
      if (result.errors.length > 0) get().toast('error', result.errors[0])
    } catch (err) {
      get().toast('error', `导入失败：${errorText(err)}`)
    }
  },

  async importFolderDialog() {
    try {
      const result = await window.api.library.importFolderDialog()
      await get().loadBooks()
      await get().loadStats()
      if (result.books.length > 0) get().toast('success', `已导入 ${result.books.length} 本书`)
      if (result.errors.length > 0) get().toast('error', result.errors[0])
    } catch (err) {
      get().toast('error', `导入失败：${errorText(err)}`)
    }
  },

  async importPaths(paths) {
    if (paths.length === 0) return
    try {
      const result = await window.api.library.importPaths(paths)
      await get().loadBooks()
      await get().loadStats()
      if (result.books.length > 0) get().toast('success', `已导入 ${result.books.length} 本书`)
      for (const err of result.errors.slice(0, 3)) get().toast('error', err)
    } catch (err) {
      get().toast('error', `导入失败：${errorText(err)}`)
    }
  },

  async removeBook(id, deleteFile) {
    try {
      const books = await window.api.library.remove(id, deleteFile)
      set({ books })
      await get().loadStats()
      get().toast('success', deleteFile ? '已删除书籍与文件' : '已从书库移除')
    } catch (err) {
      get().toast('error', `删除失败：${errorText(err)}`)
    }
  },

  async updateBook(id, patch) {
    try {
      const books = await window.api.library.update(id, patch)
      set({ books })
    } catch (err) {
      get().toast('error', `更新失败：${errorText(err)}`)
    }
  },

  async saveSettings(patch) {
    try {
      const settings = await window.api.settings.set(patch)
      set({ settings })
    } catch (err) {
      get().toast('error', `设置保存失败：${errorText(err)}`)
    }
  },

  async openReader(bookId, anchor) {
    set({ route: 'reader', reader: { ...emptyReader, bookId, loading: true, bookmarkAnchor: anchor ?? null } })
    try {
      const payload = await window.api.reader.open(bookId)
      // 从书签跳进来：直接去书签所在的那一章（位置由 ReaderPage 按 scrollRatio 恢复）
      // 否则：没有历史进度时跳过封面/制作页，从正文第一项开始
      const startIndex = anchor
        ? Math.max(0, Math.min(payload.chapters.length - 1, anchor.chapterIndex))
        : (payload.progress?.chapterIndex ?? pickStartChapter(payload))
      set({
        reader: {
          bookId,
          book: payload.book,
          toc: payload.toc,
          chapters: payload.chapters,
          chapterIndex: startIndex,
          chapterLabel: payload.chapters[startIndex]?.label ?? '',
          html: '',
          loading: true,
          error: null,
          scrollRatio: anchor ? anchor.scrollRatio : (payload.progress?.scrollRatio ?? 0),
          bookmarkAnchor: anchor ?? null,
          annotationAnchor: null
        }
      })
      await get().goToChapter(startIndex)
      await get().loadBooks()
    } catch (err) {
      set({ reader: { ...get().reader, loading: false, error: errorText(err) } })
      get().toast('error', `打开失败：${errorText(err)}`)
    }
  },

  closeReader() {
    set({ route: 'library', reader: { ...emptyReader } })
    void get().refreshAll()
  },

  async goToChapter(index, dir, resume) {
    const { reader } = get()
    if (!reader.bookId) return
    const target = Math.max(0, Math.min(reader.chapters.length - 1, index))
    // 记录换章方向：阅读器据此决定新章停在开头（向后）还是回到上次位置（向前）
    const jumpDir = dir ?? (target > reader.chapterIndex ? 'forward' : target < reader.chapterIndex ? 'backward' : reader.jumpDir)
    // 向前翻回上一章：若阅读器记过那一章读到哪，就回到那个位置；没记过才落到章末
    const restored = jumpDir === 'backward' ? resume?.positions?.[target] : undefined
    set({
      reader: {
        ...get().reader,
        loading: true,
        chapterIndex: target,
        jumpDir: restored !== undefined ? 'resume' : jumpDir,
        restoreRatio: restored
      }
    })
    try {
      const chapter = await window.api.reader.chapter(reader.bookId, target)
      set({
        reader: {
          ...get().reader,
          chapterIndex: chapter.index,
          chapterLabel: chapter.label,
          html: chapter.html,
          loading: false,
          error: null
        }
      })
    } catch (err) {
      set({ reader: { ...get().reader, loading: false, error: errorText(err) } })
      get().toast('error', `章节加载失败：${errorText(err)}`)
    }
  },

  /* ---------------- 书签 ---------------- */

  async loadBookmarks() {
    const bookmarks = await window.api.bookmarks.list()
    set({ bookmarks })
  },

  async refreshBookmarkRemaining(bookId) {
    try {
      set({ bookmarkRemaining: await window.api.bookmarks.remaining(bookId) })
    } catch {
      set({ bookmarkRemaining: 0 })
    }
  },

  setBookmarkBook(bookId) {
    set({ bookmarkBookId: bookId })
  },

  setBookmarkSort(sort) {
    set({ bookmarkSort: sort })
  },

  async addBookmark(input) {
    try {
      const created = await window.api.bookmarks.add(input)
      await get().loadBookmarks()
      await get().refreshBookmarkRemaining(input.bookId)
      if (!created) {
        const duplicate = findBookmarkAt(activeBookmarks(get().bookmarks), input.bookId, input)
        get().toast('error', duplicate ? '这个位置已经有书签了' : '这本书的书签已达 99 条上限，先删掉一些再加')
      }
      return created
    } catch (err) {
      get().toast('error', `加书签失败：${errorText(err)}`)
      return null
    }
  },

  async updateBookmark(id, patch) {
    try {
      await window.api.bookmarks.update(id, patch)
      await get().loadBookmarks()
    } catch (err) {
      get().toast('error', `书签保存失败：${errorText(err)}`)
    }
  },

  async removeBookmark(id) {
    const target = get().bookmarks.find((item) => item.id === id)
    try {
      const removed = await window.api.bookmarks.remove(id)
      await get().loadBookmarks()
      if (target) await get().refreshBookmarkRemaining(target.bookId)
      if (removed) {
        get().toast('success', '已删除书签', {
          label: '撤销',
          run: () => {
            void (async () => {
              const restored = await window.api.bookmarks.restore(id)
              await get().loadBookmarks()
              await get().refreshBookmarkRemaining(removed.bookId)
              get().toast(restored ? 'success' : 'error', restored ? '已恢复书签' : '这本书的书签已满，无法恢复')
            })()
          }
        })
      }
    } catch (err) {
      get().toast('error', `删除书签失败：${errorText(err)}`)
    }
  },

  /* ---------------- 划线 / 笔记 ---------------- */

  async loadAnnotations() {
    set({ annotations: await window.api.annotations.list() })
  },

  /**
   * 重新取当前章的 HTML。
   * 主进程会把这一章的划线 / 笔记包成 <mark> 注入，所以每次标注有增删改都要重取，
   * 否则界面上看不到刚划的那条线。
   */
  async reloadChapter() {
    const { reader } = get()
    if (!reader.bookId) return
    try {
      const chapter = await window.api.reader.chapter(reader.bookId, reader.chapterIndex)
      const current = get().reader
      // 期间可能已经换书 / 换章，这种情况就不要用旧结果覆盖
      if (current.bookId !== reader.bookId || current.chapterIndex !== reader.chapterIndex) return
      set({ reader: { ...current, chapterIndex: chapter.index, chapterLabel: chapter.label, html: chapter.html } })
    } catch (err) {
      get().toast('error', `章节重新载入失败：${errorText(err)}`)
    }
  },

  setRecordBook(bookId) {
    set({ recordBookId: bookId })
  },

  setRecordFilter(filter) {
    set({ recordFilter: filter })
  },

  annotationsOf(bookId) {
    return get().annotations.filter((item) => item.bookId === bookId && !item.deletedAt)
  },

  async addAnnotation(input) {
    try {
      const created = await window.api.annotations.add(input)
      await get().loadAnnotations()
      if (!created) {
        get().toast('error', '没能保存这条划线：没有选中文字或已达上限')
      }
      return created
    } catch (err) {
      get().toast('error', `保存划线失败：${errorText(err)}`)
      return null
    }
  },

  async updateAnnotation(id, patch) {
    try {
      await window.api.annotations.update(id, patch)
      await get().loadAnnotations()
    } catch (err) {
      get().toast('error', `保存失败：${errorText(err)}`)
    }
  },

  async removeAnnotation(id) {
    try {
      const removed = await window.api.annotations.remove(id)
      await get().loadAnnotations()
      if (removed) {
        get().toast('success', removed.note ? '已删除笔记' : '已删除划线', {
          label: '撤销',
          run: () => {
            void (async () => {
              const restored = await window.api.annotations.restore(id)
              await get().loadAnnotations()
              get().toast(restored ? 'success' : 'error', restored ? '已恢复' : '恢复失败')
            })()
          }
        })
      }
    } catch (err) {
      get().toast('error', `删除失败：${errorText(err)}`)
    }
  },

  async openAnnotation(annotation) {
    const anchor = {
      chapterIndex: annotation.chapterIndex,
      blockIndex: annotation.blockIndex,
      tokenIndex: annotation.tokenIndex,
      start: annotation.startOffset,
      endBlockIndex: annotation.endBlockIndex,
      endTokenIndex: annotation.endTokenIndex,
      end: annotation.endOffset
    }
    const { reader } = get()
    // 已经在这本书里：直接切章，位置交给 ReaderPage 按锚点定位
    if (reader.bookId === annotation.bookId) {
      set({ route: 'reader', reader: { ...reader, annotationAnchor: anchor } })
      if (reader.chapterIndex !== annotation.chapterIndex) await get().goToChapter(annotation.chapterIndex)
      return
    }
    await get().openReader(annotation.bookId, {
      chapterIndex: annotation.chapterIndex,
      scrollRatio: 0,
      excerpt: annotation.quote
    })
    set({ reader: { ...get().reader, annotationAnchor: anchor } })
  },

  async loadLanConflicts() {
    try {
      const items = await window.api.lan.pendingConflicts()
      if (items.length === 0) {
        // 已经没有待裁决的了（可能刚在别处处理过）
        set({ lanConflicts: [], lanConflictOpen: false, lanChoices: {} })
        return
      }
      const choices: Record<string, 'desktop' | 'phone'> = {}
      for (const item of items) {
        // 默认值只作初值，用户可以逐本改
        choices[item.bookId] = item.phoneAt > item.desktopAt ? 'phone' : 'desktop'
      }
      set({ lanConflicts: items, lanChoices: choices, lanConflictOpen: true })
    } catch {
      /* 取不到就当没有冲突 */
    }
  },

  setLanConflictOpen(open) {
    set({ lanConflictOpen: open })
  },

  chooseLanConflict(bookId, choice) {
    set({ lanChoices: { ...get().lanChoices, [bookId]: choice } })
  },

  chooseAllLanConflicts(choice) {
    const choices: Record<string, 'desktop' | 'phone'> = {}
    for (const item of get().lanConflicts) choices[item.bookId] = choice
    set({ lanChoices: choices })
  },

  async resolveLanConflicts() {
    try {
      const result = await window.api.lan.resolveConflicts(get().lanChoices)
      set({ lanConflicts: [], lanConflictOpen: false, lanChoices: {} })
      await get().refreshAll()
      get().toast('success', result.merged > 0 ? `已按你的选择合并 ${result.merged} 本` : '已按你的选择处理')
    } catch (err) {
      get().toast('error', `合并失败：${errorText(err)}`)
    }
  }
}))

/*
 * 界面自检用的逃生口（scripts/bookmark-ui-check.ts）。
 * 自检脚本把组件打进同一个 bundle 时，esbuild 会给「从脚本引入的 store」和
 * 「组件内部引入的 store」各生成一份模块实例，两边状态互不可见；
 * 打开这个开关后双方都从这里取同一个实例。正式运行不受影响。
 */
if (process.env.DSH_UI_CHECK) {
  const box = globalThis as unknown as { __dshApp?: typeof useApp; __dshAppCount?: number }
  box.__dshApp = useApp
  box.__dshAppCount = (box.__dshAppCount ?? 0) + 1
}
