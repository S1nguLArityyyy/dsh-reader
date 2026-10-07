import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { Book, Progress, SessionRow, Settings } from '../shared/types'
import { splitVolume, titleFromFileName } from './naming'
import { percentByPosition } from '../shared/progress'

/** 本地日期键 YYYY-MM-DD */
export function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type StoreFile = 'settings' | 'library' | 'progress' | 'sessions'

/**
 * 轻量 JSON 持久化层。
 * 全部数据落在 dataDir 下，原子写入（先写 .tmp 再 rename），
 * 关机重启后数据不丢失。
 */
export class Store {
  readonly dataDir: string
  /** 书籍文件目录：应用根目录下的 books/ */
  booksDir: string
  books: Book[] = []
  progress: Record<string, Progress> = {}
  sessions: SessionRow[] = []
  settings!: Settings

  private timers = new Map<StoreFile, NodeJS.Timeout>()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.booksDir = resolveBooksDir(dataDir)
  }

  get defaultBooksDir(): string {
    return resolveBooksDir(this.dataDir)
  }

  get coversDir(): string {
    return join(this.dataDir, 'covers')
  }

  get cacheDir(): string {
    return join(this.dataDir, 'cache')
  }

  get syncDir(): string {
    return join(this.dataDir, 'sync')
  }

  private defaultSettings(): Settings {
    return {
      dataDir: this.dataDir,
      deviceId: randomUUID(),
      deviceName: hostname() || 'Windows PC',
      theme: 'light',
      librarySort: 'recent',
      dailyGoalMinutes: 30,
      reader: {
        fontSize: 18,
        lineHeight: 1.9,
        fontFamily: 'system',
        pageWidth: 720,
        padding: 36,
        theme: 'paper',
        mode: 'scroll'
      },
      sync: {
        provider: 'local',
        localCloudDir: null,
        webdav: { url: '', username: '' },
        auto: false,
        onReaderClose: true,
        intervalMinutes: 10,
        remoteDir: '/DshReader',
        conflictPolicy: 'ask',
        uploadBooks: false
      },
      appearance: {
        accent: '#3b6fd4',
        backgroundImage: null,
        readerBackgroundImage: null,
        backgroundOpacity: 0.18
      }
    }
  }

  async init(): Promise<void> {
    await this.setupBooksDir()
    await mkdir(this.coversDir, { recursive: true })
    await mkdir(this.cacheDir, { recursive: true })
    await mkdir(this.syncDir, { recursive: true })

    const defaults = this.defaultSettings()
    const saved = await this.readJson<Partial<Settings>>('settings', {})
    this.settings = {
      ...defaults,
      ...saved,
      dataDir: this.dataDir,
      reader: { ...defaults.reader, ...(saved.reader ?? {}) },
      sync: {
        ...defaults.sync,
        ...(saved.sync ?? {}),
        webdav: { ...defaults.sync.webdav, ...(saved.sync?.webdav ?? {}) }
      },
      appearance: { ...defaults.appearance, ...(saved.appearance ?? {}) }
    }
    this.books = await this.readJson<Book[]>('library', [])
    this.progress = await this.readJson<Record<string, Progress>>('progress', {})
    this.sessions = await this.readJson<SessionRow[]>('sessions', [])

    // 阅读时长行补上设备号（老数据都是本机产生的），同步时才分得清哪些条目是自己的
    let sessionsFixed = false
    for (const row of this.sessions) {
      if (!row.deviceId) {
        row.deviceId = this.settings.deviceId
        sessionsFixed = true
      }
    }
    if (sessionsFixed) this.save('sessions')

    // 老版本把书籍副本放在数据目录里，统一迁移到应用根目录的 books/
    await this.migrateBookFiles()

    // 1) 兼容旧版本数据：补齐后来新增的字段，避免读取时 undefined
    // 2) 书名 / 卷号 / 系列归组按当前规则从文件名重算，
    //    这样解析规则改进后，已导入的书也会自动更新，无需重新导入。
    let regrouped = false
    for (const book of this.books) {
      if (!Array.isArray(book.chapterChars)) {
        book.chapterChars = []
        regrouped = true
      }
      if (typeof book.wordCount !== 'number') {
        book.wordCount = 0
        regrouped = true
      }
      if (typeof book.description !== 'string') {
        book.description = ''
        regrouped = true
      }
      if (book.coverColor === undefined) {
        book.coverColor = null
        regrouped = true
      }
      if (typeof book.chapterCount !== 'number') {
        book.chapterCount = book.chapterChars.length
        regrouped = true
      }
      if (typeof book.metaTitle !== 'string') {
        book.metaTitle = book.title ?? ''
        regrouped = true
      }
      if (book.contentHash === undefined) {
        book.contentHash = null
        regrouped = true
      }
      if (book.manualSeries === undefined) {
        book.manualSeries = null
        regrouped = true
      }

      const title = titleFromFileName(book.fileName ?? '', book.metaTitle)
      const { volume, seriesKey } = splitVolume(title)
      if (book.title !== title || book.volume !== volume || book.seriesKey !== seriesKey) {
        book.title = title
        book.volume = volume
        book.seriesKey = seriesKey
        regrouped = true
      }
    }
    if (regrouped) this.save('library')

    // 进度重算：早期版本按「章节序号」存百分比，看上去像章节进度。
    // 现在字数已就绪，统一改写成按阅读位置计算的整书进度。
    let progressFixed = false
    for (const book of this.books) {
      const record = this.progress[book.id]
      if (!record || book.chapterChars.length === 0 || book.wordCount <= 0) continue
      const percent = percentByPosition(
        book.chapterChars,
        book.wordCount,
        record.chapterIndex,
        record.scrollRatio
      )
      if (Math.abs(percent - record.percent) > 0.0005) {
        record.percent = percent
        progressFixed = true
      }
    }
    if (progressFixed) this.save('progress')
  }

  private path(name: StoreFile): string {
    return join(this.dataDir, `${name}.json`)
  }

  /** 书籍目录准备：应用根目录不可写时（例如装到了 Program Files）回退到数据目录 */
  private async setupBooksDir(): Promise<void> {
    try {
      await mkdir(this.booksDir, { recursive: true })
      const probe = join(this.booksDir, '.write-test')
      await writeFile(probe, 'ok', 'utf8')
      await rm(probe, { force: true })
    } catch (err) {
      console.error('[store] 应用根目录不可写，书籍改存到数据目录', err)
      this.booksDir = join(this.dataDir, 'books')
      await mkdir(this.booksDir, { recursive: true })
    }
  }

  /** 把旧位置（数据目录内）的书籍副本迁移到 books/，用户自己的原始文件不动 */
  private async migrateBookFiles(): Promise<void> {
    let changed = false
    const insideData = (p: string): boolean => resolve(p).startsWith(resolve(this.dataDir) + sep)

    for (const book of this.books) {
      if (!book.filePath) continue
      const target = join(this.booksDir, `${book.id}.epub`)
      if (resolve(book.filePath) === resolve(target)) continue

      if (!existsSync(book.filePath)) {
        if (existsSync(target)) {
          book.filePath = target
          changed = true
        }
        continue
      }

      try {
        await copyFile(book.filePath, target)
        // 只删除位于应用数据目录里的旧副本，绝不碰用户自己的文件
        if (insideData(book.filePath)) await rm(book.filePath, { force: true })
        book.filePath = target
        changed = true
      } catch (err) {
        console.error(`[store] 迁移《${book.title}》失败`, err)
      }
    }

    if (changed) {
      this.save('library')
      console.log(`[store] 书籍目录：${this.booksDir}`)
    }
  }

  private async readJson<T>(name: StoreFile, fallback: T): Promise<T> {
    try {
      const raw = await readFile(this.path(name), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private async writeJson(name: StoreFile, data: unknown): Promise<void> {
    const target = this.path(name)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, target)
  }

  /** 防抖保存，避免高频写入 */
  save(name: StoreFile, immediate = false): void {
    const existing = this.timers.get(name)
    if (existing) clearTimeout(existing)
    const flush = async (): Promise<void> => {
      this.timers.delete(name)
      const payload =
        name === 'settings'
          ? this.settings
          : name === 'library'
            ? this.books
            : name === 'progress'
              ? this.progress
              : this.sessions
      try {
        await this.writeJson(name, payload)
      } catch (err) {
        console.error(`[store] 写入 ${name}.json 失败`, err)
      }
    }
    if (immediate) {
      void flush()
      return
    }
    this.timers.set(name, setTimeout(() => void flush(), 250))
  }

  async flushAll(): Promise<void> {
    for (const name of ['settings', 'library', 'progress', 'sessions'] as StoreFile[]) {
      const t = this.timers.get(name)
      if (t) clearTimeout(t)
      this.timers.delete(name)
      const payload =
        name === 'settings'
          ? this.settings
          : name === 'library'
            ? this.books
            : name === 'progress'
              ? this.progress
              : this.sessions
      await this.writeJson(name, payload)
    }
  }

  /**
   * 累加阅读时长到「书 + 天 + 设备」聚合行。
   * 必须带上设备号匹配：同步回来的别的设备的行不能被本地心跳改写。
   */
  addReadingTime(bookId: string, seconds: number): void {
    if (!bookId || seconds <= 0) return
    const day = todayKey()
    const now = Date.now()
    const deviceId = this.settings.deviceId
    let row = this.sessions.find(
      (s) => s.bookId === bookId && s.day === day && (s.deviceId ?? deviceId) === deviceId
    )
    if (!row) {
      row = { id: randomUUID(), bookId, day, seconds: 0, firstAt: now, lastAt: now, deviceId }
      this.sessions.push(row)
    }
    row.deviceId = deviceId
    row.seconds += Math.round(seconds)
    row.lastAt = now
    this.save('sessions')
  }

  setProgress(bookId: string, patch: Partial<Progress>): Progress {
    const now = Date.now()
    const current: Progress =
      this.progress[bookId] ??
      ({
        bookId,
        percent: 0,
        chapterIndex: 0,
        chapterTitle: '',
        scrollRatio: 0,
        updatedAt: now,
        deviceId: this.settings.deviceId,
        rev: 0
      } satisfies Progress)
    const next: Progress = {
      ...current,
      ...patch,
      bookId,
      updatedAt: now,
      deviceId: this.settings.deviceId,
      rev: current.rev + 1
    }
    next.percent = Math.min(1, Math.max(0, next.percent))
    this.progress[bookId] = next
    this.save('progress')
    return next
  }
}

/** 主进程使用的数据目录：可用 DSH_DATA_DIR 覆盖（开发 / 截图用） */
export function resolveDataDir(): string {
  const override = process.env.DSH_DATA_DIR
  if (override && override.trim()) return override.trim()
  return app.getPath('userData')
}

/**
 * 应用根目录：
 *  - 免安装版：PORTABLE_EXECUTABLE_DIR（exe 所在目录，而不是解压出来的临时目录）
 *  - 安装版：exe 所在目录
 *  - 开发模式：项目根目录
 */
export function appRootDir(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable && portable.trim()) return portable.trim()
  return app.isPackaged ? dirname(process.execPath) : app.getAppPath()
}

/** 书籍文件存放目录：应用根目录下的 books/，方便直接查看与备份 */
export function resolveBooksDir(dataDir: string): string {
  const override = process.env.DSH_BOOKS_DIR
  if (override && override.trim()) return override.trim()
  return join(appRootDir(), 'books')
}
