import { create } from 'zustand'
import { percentByPosition } from '@shared/progress'
import type {
  AppInfo,
  Book,
  ChapterRef,
  ConflictItem,
  Settings,
  StatsPayload,
  SyncState,
  TocEntry
} from '@shared/types'

export type Route = 'library' | 'stats' | 'settings' | 'reader'

export interface ToastItem {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
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
  scrollRatio: 0
}

const emptySync: SyncState = {
  phase: 'idle',
  loggedIn: false,
  account: null,
  lastSyncAt: null,
  tasks: [],
  transferred: 0,
  total: 0,
  message: null
}

/** 设计阶段用于预览冲突弹窗的示例数据（真实数据由同步引擎在 M5 提供） */
const PREVIEW_CONFLICTS: ConflictItem[] = [
  {
    bookId: 'preview-1',
    title: '败犬女主太多了！09',
    localPercent: 0.62,
    localAt: Date.now() - 1000 * 60 * 42,
    localDevice: 'DESKTOP-PC',
    cloudPercent: 0.35,
    cloudAt: Date.now() - 1000 * 60 * 60 * 6,
    cloudDevice: 'Phone'
  },
  {
    bookId: 'preview-2',
    title: '雪国',
    localPercent: 0.18,
    localAt: Date.now() - 1000 * 60 * 60 * 30,
    localDevice: 'DESKTOP-PC',
    cloudPercent: 0.74,
    cloudAt: Date.now() - 1000 * 60 * 25,
    cloudDevice: 'Phone'
  }
]

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
  sync: SyncState
  conflicts: ConflictItem[]
  conflictPreview: boolean
  syncModalOpen: boolean
  conflictModalOpen: boolean
  toasts: ToastItem[]
  reader: ReaderState
  /** 书籍详情弹窗 */
  detailBookId: string | null
  /** 书库筛选：null=全部，'__singles__'=单册，其它=系列名 */
  seriesFilter: string | null
  /** 侧边栏系列二级菜单是否展开 */
  seriesOpen: boolean
  /** 书库搜索词（匹配书名 / 作者 / 系列） */
  search: string
  /** 多选管理模式 */
  selectMode: boolean
  selected: string[]

  init: () => Promise<void>
  go: (route: Route) => void
  toast: (kind: ToastItem['kind'], text: string) => void
  dismissToast: (id: number) => void
  openDetail: (bookId: string) => void
  closeDetail: () => void
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
  loadSync: () => Promise<void>
  refreshAll: () => Promise<void>

  importDialog: () => Promise<void>
  importFolderDialog: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  removeBook: (id: string, deleteFile: boolean) => Promise<void>
  updateBook: (id: string, patch: Partial<Book>) => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  markAllSyncUpload: (value: boolean) => Promise<void>

  openReader: (bookId: string) => Promise<void>
  closeReader: () => void
  goToChapter: (index: number) => Promise<void>

  setSyncModal: (open: boolean) => void
  setConflictModal: (open: boolean) => void
  runSync: () => Promise<void>
  cancelSync: () => Promise<void>
  connectSync: () => Promise<void>
  configureWebdav: (payload: { url: string; username: string; password?: string }) => Promise<void>
  logoutSync: () => Promise<void>
  downloadAll: () => Promise<void>
  resolveConflicts: (choice: 'local' | 'cloud') => Promise<void>
  previewConflicts: () => void
}

let toastSeq = 0

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  route: 'library',
  info: null,
  books: [],
  settings: null,
  stats: null,
  sync: emptySync,
  conflicts: [],
  conflictPreview: false,
  syncModalOpen: false,
  conflictModalOpen: false,
  toasts: [],
  reader: { ...emptyReader },
  detailBookId: null,
  seriesFilter: null,
  seriesOpen: true,
  search: '',
  selectMode: false,
  selected: [],

  async init() {
    try {
      const params = new URLSearchParams(window.location.search)
      const routeParam = (params.get('route') ?? 'library') as Route
      const modal = params.get('modal') ?? ''
      const bookParam = params.get('book') ?? ''

      const [info, settings, books, stats, sync] = await Promise.all([
        window.api.app.info(),
        window.api.settings.get(),
        window.api.library.list(),
        window.api.stats.get(),
        Promise.resolve(emptySync)
      ])

      set({
        info,
        settings,
        books: [...books].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)),
        stats,
        sync,
        route: routeParam,
        ready: true
      })

      if (modal === 'sync') set({ syncModalOpen: true })
      if (modal === 'conflict') get().previewConflicts()
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

  toast(kind, text) {
    toastSeq += 1
    const id = toastSeq
    set({ toasts: [...get().toasts, { id, kind, text }] })
    window.setTimeout(() => get().dismissToast(id), 4200)
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

  async markAllSyncUpload(value) {
    try {
      await window.api.library.markSyncUpload(value)
      await get().loadBooks()
      get().toast('info', value ? '已把全部书籍标为「同步到云端」' : '已取消全部书籍的云端同步标记')
    } catch (err) {
      get().toast('error', errorText(err))
    }
  },

  async loadBooks() {
    const books = await window.api.library.list()
    set({ books: [...books].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)) })
  },

  async loadStats() {
    set({ stats: await window.api.stats.get() })
  },

  async loadSync() {
    const [sync, conflicts] = await Promise.all([Promise.resolve(emptySync), []])
    const preview = get().conflictPreview
    set({ sync, conflicts: conflicts.length > 0 ? conflicts : preview ? PREVIEW_CONFLICTS : [] })
  },

  async refreshAll() {
    await Promise.all([get().loadBooks(), get().loadStats(), get().loadSync()])
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

  async openReader(bookId) {
    set({ route: 'reader', reader: { ...emptyReader, bookId, loading: true } })
    try {
      const payload = await window.api.reader.open(bookId)
      // 没有历史进度时，跳过封面/制作页，从正文第一项开始
      const startIndex = payload.progress?.chapterIndex ?? pickStartChapter(payload)
      set({
        reader: {
          bookId,
          book: payload.book,
          toc: payload.toc,
          chapters: payload.chapters,
          chapterIndex: startIndex,          chapterLabel: payload.chapters[startIndex]?.label ?? '',
          html: '',
          loading: true,
          error: null,
          scrollRatio: payload.progress?.scrollRatio ?? 0
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
    // 合上书顺手同步一次（主进程会稍等片刻，让卸载时刷下的最后一条进度先落到本地）
  },

  async goToChapter(index) {
    const { reader } = get()
    if (!reader.bookId) return
    const target = Math.max(0, Math.min(reader.chapters.length - 1, index))
    set({ reader: { ...get().reader, loading: true, chapterIndex: target } })
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

  setSyncModal(open) {
    set({ syncModalOpen: open })
    if (open) void get().loadSync()
  },

  setConflictModal(open) {
    set({ conflictModalOpen: open })
    if (open) void get().loadSync()
  },

  async runSync() {
    try {
      const sync = await emptySync
      set({ sync })
      // 进度 / 今日阅读 / 统计都可能变了，立刻刷新（自动同步那条路走 sync:changed 事件）
      await get().loadBooks()
      await get().loadStats()
      if (sync.phase === 'conflict') {
        await get().loadSync()
        set({ conflictModalOpen: true, conflictPreview: false })
        get().toast('info', sync.message ?? '发现阅读进度冲突，请选择保留哪一边')
        return
      }
      if (sync.message) get().toast(sync.phase === 'error' ? 'error' : 'info', sync.message)
    } catch (err) {
      get().toast('error', `同步失败：${errorText(err)}`)
    }
  },

  async cancelSync() {
    const sync = await emptySync
    set({ sync })
  },

  async connectSync() {
    try {
      const sync = await emptySync
      // 连接时主进程会把选中的目录写进设置，这里跟着刷新一次
      const settings = await window.api.settings.get()
      set({ sync, settings })
      await get().loadBooks()
      await get().loadStats()
      if (sync.phase === 'conflict') {
        await get().loadSync()
        set({ conflictModalOpen: true, conflictPreview: false })
        get().toast('info', sync.message ?? '发现阅读进度冲突，请选择保留哪一边')
        return
      }
      if (sync.message) get().toast('info', sync.message)
    } catch (err) {
      get().toast('error', errorText(err))
    }
  },

  async downloadAll() {
    try {
      const sync = await emptySync
      set({ sync })
      await get().loadBooks()
      await get().loadStats()
      if (sync.message) get().toast('info', sync.message)
    } catch (err) {
      get().toast('error', errorText(err))
    }
  },

  async configureWebdav(payload) {
    try {
      const sync = await emptySync
      // 地址与账号落在设置里；应用密码只在主进程，不回传
      const settings = await window.api.settings.get()
      set({ sync, settings })
      await get().loadBooks()
      await get().loadStats()
      if (sync.message) get().toast(sync.phase === 'error' ? 'error' : 'info', sync.message)
    } catch (err) {
      get().toast('error', errorText(err))
    }
  },

  async logoutSync() {
    try {
      const sync = await emptySync
      set({ sync })
      if (sync.message) get().toast('info', sync.message)
    } catch (err) {
      get().toast('error', errorText(err))
    }
  },

  async resolveConflicts(choice) {
    try {
      const sync = await emptySync
      set({ sync, conflictModalOpen: false, conflicts: [], conflictPreview: false })
      get().toast('success', choice === 'local' ? '已选择保留本地版本' : '已选择使用云端版本')
    } catch (err) {
      get().toast('error', errorText(err))
    }
  },

  previewConflicts() {
    set({ conflicts: PREVIEW_CONFLICTS, conflictPreview: true, conflictModalOpen: true })
  }
}))
