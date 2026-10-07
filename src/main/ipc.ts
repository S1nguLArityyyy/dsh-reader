import { app, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  AppInfo,
  Book,
  BookOpenPayload,
  ChapterPayload,
  ChapterRef,
  ConflictItem,
  Progress,
  Settings,
  StatsPayload,
  TocEntry
} from '../shared/types'
import { readChapter, readEpubMeta } from './epub'
import { ensureExtracted, flattenToc, importMany, removeBook, scanEpubFiles } from './library'
import { toMediaUrl } from './media'
import { computeStats } from './stats'
import type { Store } from './store'
import type { SyncService, WebDavConnectPayload } from './sync'

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
    sync: { ...store.settings.sync, ...(patch.sync ?? {}) },
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

export function registerIpc(store: Store, sync: SyncService): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args: any[]) => fn(...args))
  }

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    dataDir: store.dataDir,
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

  /* ---------------- 统计 ---------------- */

  handle('stats:get', (): StatsPayload => computeStats(store))

  /* ---------------- 书库 ---------------- */

  /** 批量标记「同步到云端」：省得一本一本点（不影响云端已有的文件） */
  handle('library:markSyncUpload', (value: boolean) => {
    for (const book of store.books) book.syncUpload = Boolean(value)
    store.save('library', true)
    return store.books
  })



  /* ---------------- 网盘 / 云端同步 ---------------- */

  handle('sync:status', () => sync.status())
  handle('sync:connect', () => sync.connect())
  handle('sync:run', () => sync.run())
  handle('sync:cancel', () => sync.cancel())
  handle('sync:downloadAll', () => sync.downloadAll())
  handle('sync:conflicts', () => sync.pendingConflicts())
  handle('sync:resolve', (items: ConflictItem[], choice: 'local' | 'cloud') => sync.resolve(items, choice))
  handle('sync:configureWebdav', (payload: WebDavConnectPayload) => sync.configureWebdav(payload))
  handle('sync:logout', () => sync.logout())
  /** 退出阅读时顺手同步（主进程延迟一点点再跑，不阻塞界面） */
  handle('sync:afterReading', () => sync.afterReading())

  /* ---------------- 系统 ---------------- */

  handle('shell:openPath', (target: string) => shell.openPath(target))
}
