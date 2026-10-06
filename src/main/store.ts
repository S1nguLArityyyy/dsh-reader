import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Book, Progress, SessionRow, Settings } from '../shared/types'
import { splitVolume } from './naming'

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
  books: Book[] = []
  progress: Record<string, Progress> = {}
  sessions: SessionRow[] = []
  settings!: Settings

  private timers = new Map<StoreFile, NodeJS.Timeout>()

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  get booksDir(): string {
    return join(this.dataDir, 'books')
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
        auto: false,
        intervalMinutes: 10,
        remoteDir: '/DshReader',
        conflictPolicy: 'ask',
        uploadBooks: false
      }
    }
  }

  async init(): Promise<void> {
    await mkdir(this.booksDir, { recursive: true })
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
      sync: { ...defaults.sync, ...(saved.sync ?? {}) }
    }
    this.books = await this.readJson<Book[]>('library', [])
    this.progress = await this.readJson<Record<string, Progress>>('progress', {})
    this.sessions = await this.readJson<SessionRow[]>('sessions', [])

    // 卷号 / 系列归组由书名推导，启动时按当前规则重算，
    // 这样解析规则改进后，已导入的书也会自动重新分组，无需重新导入。
    let regrouped = false
    for (const book of this.books) {
      const { volume, seriesKey } = splitVolume(book.title)
      if (book.volume !== volume || book.seriesKey !== seriesKey) {
        book.volume = volume
        book.seriesKey = seriesKey
        regrouped = true
      }
    }
    if (regrouped) this.save('library')
  }

  private path(name: StoreFile): string {
    return join(this.dataDir, `${name}.json`)
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

  /** 累加阅读时长到「书 + 天」聚合行 */
  addReadingTime(bookId: string, seconds: number): void {
    if (!bookId || seconds <= 0) return
    const day = todayKey()
    const now = Date.now()
    let row = this.sessions.find((s) => s.bookId === bookId && s.day === day)
    if (!row) {
      row = { id: randomUUID(), bookId, day, seconds: 0, firstAt: now, lastAt: now }
      this.sessions.push(row)
    }
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
