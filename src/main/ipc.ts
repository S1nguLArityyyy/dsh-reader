import { app, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  AppInfo,
  Book,
  Bookmark,
  BookOpenPayload,
  ChapterPayload,
  ChapterRef,
  Progress,
  Settings,
  StatsPayload,
  TocEntry
} from '../shared/types'
import type { BookmarkInput, BookmarkSort } from '../shared/bookmarks'
import { percentByPosition } from '../shared/progress'
import { readChapter, readEpubMeta } from './epub'
import type { LanPendingConflict } from './lan'
import { ensureExtracted, flattenToc, importMany, removeBook, scanEpubFiles } from './library'
import { toMediaUrl } from './media'
import { computeStats } from './stats'
import type { Store } from './store'

interface BookMetaCache {
  toc: TocEntry[]
  chapters: ChapterRef[]
  opfDir: string
}

const metaCache = new Map<string, BookMetaCache>()

function applySettingsPatch(store: Store, patch: Partial<Settings>): void {
  const next: Settings = {
    ...store.settings,
    ...patch,
    reader: { ...store.settings.reader, ...(patch.reader ?? {}) },
    appearance: { ...store.settings.appearance, ...(patch.appearance ?? {}) }
  }
  next.dataDir = store.dataDir
  store.settings = next
  store.save('settings')
}

async function loadBookMeta(store: Store, book: Book): Promise<BookMetaCache> {
  const cached = metaCache.get(book.id)
  if (cached) return cached
  const meta = await readEpubMeta(book.filePath)
  const toc = flattenToc(meta)
  const labelByHref = new Map<string, string>()
  for (const entry of toc) {
    const href = meta.chapterHrefs[entry.chapterIndex]
    if (href && !labelByHref.has(href)) labelByHref.set(href, entry.label)
  }
  const chapters: ChapterRef[] = meta.chapterHrefs.map((href, index) => {
    const fromToc = labelByHref.get(href)
    if (fromToc) return { index, href, label: fromToc }
    if (/cover/i.test(href)) return { index, href, label: '封面' }
    if (/nav|toc/i.test(href)) return { index, href, label: '目录' }
    return { index, href, label: `第 ${index + 1} 章` }
  })
  const value: BookMetaCache = { toc, chapters, opfDir: meta.opfDir }
  metaCache.set(book.id, value)
  return value
}

export interface LanBridge {
  url: () => string
  lastPush: () => { at: number; progress: number; sessions: number }
  transfer: () => { name: string; sent: number; total: number } | null
  /** 手机推来的记录与电脑端冲突、还没裁决的那些 */
  pendingConflicts?: () => LanPendingConflict[]
  /** 应用裁决：选择合并并落盘 */
  resolveConflicts?: (choices: Record<string, 'desktop' | 'phone'>) => Promise<{ merged: number }>
}

/** 局域网状态查询的兜底实现：纯 Node 下跑自检（不起服务）时用 */
const NO_LAN: LanBridge = {
  url: () => '',
  lastPush: () => ({ at: 0, progress: 0, sessions: 0 }),
  transfer: () => null,
  pendingConflicts: () => [],
  resolveConflicts: async () => ({ merged: 0 })
}

export function registerIpc(store: Store, lan: LanBridge = NO_LAN): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args: any[]) => fn(...args))
  }

  handle('lan:reloadRecords', async () => {
    await store.reloadRecords()
    return true
  })

  handle('lan:pendingConflicts', () => lan.pendingConflicts?.() ?? [])

  /** 用户裁决完：合并落盘后把记录重新读进内存，否则内存里的旧值会在下次保存时覆盖回去 */
  handle('lan:resolveConflicts', async (choices: Record<string, 'desktop' | 'phone'>) => {
    const result = (await lan.resolveConflicts?.(choices ?? {})) ?? { merged: 0 }
    await store.reloadRecords()
    return result
  })

  handle('lan:openBooksDir', () => shell.openPath(store.booksDir))

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    dataDir: store.dataDir,
    lanUrl: lan.url(),
    lastRecordPush: lan.lastPush(),
    lanTransfer: lan.transfer(),
    booksDir: store.booksDir,
    coversDir: store.coversDir,
    cacheDir: store.cacheDir,
    platform: process.platform
  }))

  /* ---------------- 设置 ---------------- */

  handle('settings:get', () => store.settings)
  handle('settings:set', (patch: Partial<Settings>) => {
    applySettingsPatch(store, patch)
    return store.settings
  })

  handle('dialog:chooseFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('dialog:chooseImage', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  /**
   * 选一张背景图并复制进数据目录。
   * 必须复制：dsh:// 协议只允许读取数据目录内的文件，直接引用外部路径会加载失败。
   */
  handle('appearance:pickBackdrop', async (kind: 'app' | 'reader') => {
    const result = await dialog.showOpenDialog({
      title: kind === 'app' ? '选择应用背景图' : '选择阅读器背景图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const source = result.filePaths[0]
    const ext = extname(source).toLowerCase() || '.jpg'
    const assetDir = join(store.dataDir, 'assets')
    await mkdir(assetDir, { recursive: true })
    const target = join(assetDir, kind === 'app' ? `background${ext}` : `reader-background${ext}`)

    // 先清掉旧的其他扩展名文件，避免残留
    for (const name of await readdir(assetDir).catch(() => [] as string[])) {
      if (name.startsWith(kind === 'app' ? 'background.' : 'reader-background.')) {
        await rm(join(assetDir, name), { force: true })
      }
    }
    await copyFile(source, target)
    return target
  })

  handle(
    'dialog:confirm',    async (options: {
      title: string
      message: string
      detail?: string
      confirmText?: string
      danger?: boolean
    }): Promise<boolean> => {
      const { response } = await dialog.showMessageBox({
        type: options.danger ? 'warning' : 'question',
        buttons: [options.confirmText ?? '确定', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: options.title,
        message: options.message,
        detail: options.detail
      })
      return response === 0
    }
  )

  /* ---------------- 书库 ---------------- */

  handle('library:list', () => store.books)

  handle('library:importDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 EPUB 电子书',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }]
    })
    if (result.canceled) return { books: [] as Book[], errors: [] as string[] }
    return importMany(store, result.filePaths)
  })

  handle('library:importFolderDialog', async () => {
    const result = await dialog.showOpenDialog({ title: '选择包含 EPUB 的文件夹', properties: ['openDirectory'] })
    if (result.canceled) return { books: [] as Book[], errors: [] as string[] }
    const files: string[] = []
    for (const dir of result.filePaths) files.push(...(await scanEpubFiles(dir)))
    if (files.length === 0) return { books: [] as Book[], errors: ['所选文件夹内没有找到 EPUB 文件'] }
    return importMany(store, files)
  })

  handle('library:importPaths', async (paths: string[]) => {
    const files: string[] = []
    const skipped: string[] = []
    for (const p of paths) {
      if (p.toLowerCase().endsWith('.epub')) files.push(p)
      else skipped.push(p)
    }
    const result = await importMany(store, files)
    return { ...result, errors: [...result.errors, ...skipped.map((s) => `${s}：当前版本仅支持 EPUB`)] }
  })

  handle('library:remove', async (id: string, deleteFile: boolean) => {
    metaCache.delete(id)
    await removeBook(store, id, deleteFile)
    return store.books
  })

  handle('library:update', (id: string, patch: Partial<Book>) => {
    const book = store.books.find((b) => b.id === id)
    if (book) {
      Object.assign(book, patch)
      store.save('library')
    }
    // 读完标记要单独存一份：它得能跟着记录同步走（library.json 不参与同步）
    if (typeof (patch as { finished?: unknown }).finished === 'boolean') {
      store.setFinished(id, (patch as { finished: boolean }).finished)
    }
    return store.books
  })

  handle('library:clearRecords', (id: string) => {
    // 只清除这本书的阅读记录（进度 + 时长），书本身保留
    delete store.progress[id]
    store.sessions = store.sessions.filter((row) => row.bookId !== id)
    store.save('progress')
    store.save('sessions')
    return store.books
  })

  handle('library:clearAllRecords', () => {
    // 清空所有书的阅读记录，书全部保留
    store.progress = {}
    store.sessions = []
    store.save('progress')
    store.save('sessions')
    return store.books
  })

  handle('library:reveal', (id: string) => {
    const book = store.books.find((b) => b.id === id)
    if (book) shell.showItemInFolder(book.filePath)
    return true
  })

  /* ---------------- 阅读器 ---------------- */

  handle('reader:open', async (bookId: string): Promise<BookOpenPayload> => {
    const book = store.books.find((b) => b.id === bookId)
    if (!book) throw new Error('书籍不存在')
    await ensureExtracted(store, book)
    const meta = await loadBookMeta(store, book)
    book.lastOpenedAt = Date.now()
    store.save('library')
    return {
      book,
      toc: meta.toc,
      chapters: meta.chapters,
      progress: store.progress[bookId] ?? null
    }
  })

  handle('reader:chapter', async (bookId: string, index: number): Promise<ChapterPayload> => {
    const book = store.books.find((b) => b.id === bookId)
    if (!book) throw new Error('书籍不存在')
    const meta = await loadBookMeta(store, book)
    const cacheDir = await ensureExtracted(store, book)
    const ref = meta.chapters[index]
    if (!ref) throw new Error('章节不存在')
    const chapter = await readChapter(cacheDir, meta.opfDir, ref.href, toMediaUrl)
    return { index, label: ref.label, total: meta.chapters.length, html: chapter.html }
  })

  handle('reader:progress', (bookId: string, patch: Partial<Progress>) => store.setProgress(bookId, patch))

  handle('reader:tick', (bookId: string, seconds: number) => {
    store.addReadingTime(bookId, seconds)
    return true
  })

  /* ---------------- 书签 ---------------- */

  handle('bookmarks:list', (bookId?: string, sort: BookmarkSort = 'recent'): Bookmark[] =>
    store.bookmarkStore.list(sort, bookId)
  )

  /** 某本书还能加几条书签（墓碑也占额度，见 shared/bookmarks.ts） */
  handle('bookmarks:remaining', (bookId: string) => store.bookmarkStore.remaining(bookId))

  handle('bookmarks:add', (input: BookmarkInput): Bookmark | null => {
    const book = store.books.find((b) => b.id === input?.bookId)
    if (!book) return null
    // 整书进度以主进程为准：章内比例 × 各章字数，与底栏显示的是同一套算法
    const percent = percentByPosition(
      book.chapterChars,
      book.wordCount,
      input.chapterIndex,
      input.scrollRatio
    )
    const created = store.bookmarkStore.add({ ...input, percent }, store.settings.deviceId)
    if (created) store.save('bookmarks')
    return created
  })

  handle(
    'bookmarks:update',
    (id: string, patch: { note?: string; scrollRatio?: number; excerpt?: string }): Bookmark | null => {
      const current = store.bookmarks.find((item) => item.id === id)
      if (!current) return null
      let percent: number | undefined
      if (patch?.scrollRatio !== undefined) {
        const book = store.books.find((b) => b.id === current.bookId)
        if (book) {
          percent = percentByPosition(
            book.chapterChars,
            book.wordCount,
            current.chapterIndex,
            patch.scrollRatio
          )
        }
      }
      const updated = store.bookmarkStore.update(id, { ...(patch ?? {}), percent })
      if (updated) store.save('bookmarks')
      return updated
    }
  )

  handle('bookmarks:remove', (id: string): Bookmark | null => {
    const removed = store.bookmarkStore.remove(id)
    if (removed) store.save('bookmarks')
    return removed
  })

  handle('bookmarks:restore', (id: string): Bookmark | null => {
    const restored = store.bookmarkStore.restore(id)
    if (restored) store.save('bookmarks')
    return restored
  })

  /* ---------------- 统计 ---------------- */

  handle('stats:get', (): StatsPayload => computeStats(store))

  /* ---------------- 系统 ---------------- */

  handle('shell:openPath', (target: string) => shell.openPath(target))
}
