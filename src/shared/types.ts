/** 跨进程共享的数据结构定义（主进程 / preload / 渲染进程共用） */

export type BookFormat = 'epub'

/** 书库中的一本书 */
export interface Book {
  id: string
  title: string
  author: string
  format: BookFormat
  fileName: string
  /** 书库内副本的绝对路径 */
  filePath: string
  fileSize: number
  /** 封面文件绝对路径，解析失败时为 null */
  coverFile: string | null
  chapterCount: number
  /** 卷号，如 "9"；无卷号时为 null */
  volume: string | null
  /** 同系列归组键（去掉卷号后的书名） */
  seriesKey: string | null
  addedAt: number
  lastOpenedAt: number | null
  hidden: boolean
  /** 是否将该书文件上传到网盘（按需上传策略，默认 false） */
  syncUpload: boolean
}

/** 单本书的阅读进度（未来与手机端交换的最小单元） */
export interface Progress {
  bookId: string
  /** 0 ~ 1 */
  percent: number
  chapterIndex: number
  chapterTitle: string
  /** 章节内滚动比例 0 ~ 1 */
  scrollRatio: number
  updatedAt: number
  deviceId: string
  /** 单调递增版本号，用于冲突检测 */
  rev: number
}

/** 按「书 + 天」聚合的阅读会话 */
export interface SessionRow {
  id: string
  bookId: string
  /** YYYY-MM-DD（本地时区） */
  day: string
  seconds: number
  firstAt: number
  lastAt: number
}

export type ReaderTheme = 'paper' | 'sepia' | 'green' | 'night'

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  fontFamily: 'system' | 'serif' | 'kai' | 'hei'
  pageWidth: number
  padding: number
  theme: ReaderTheme
  mode: 'scroll' | 'paged'
}

export interface SyncSettings {
  /** 自动同步开关 */
  auto: boolean
  intervalMinutes: number
  /** 网盘中的同步文件夹 */
  remoteDir: string
  conflictPolicy: 'ask' | 'local' | 'cloud'
  /** 是否同步书籍文件本体（按需上传策略，默认关闭） */
  uploadBooks: boolean
}

export interface Settings {
  dataDir: string
  deviceId: string
  deviceName: string
  theme: 'light' | 'dark'
  librarySort: 'recent' | 'added' | 'title'
  reader: ReaderSettings
  sync: SyncSettings
}

export interface TocNode {
  label: string
  href: string
  children: TocNode[]
}

export interface TocEntry {
  id: string
  label: string
  chapterIndex: number
  level: number
}

export interface ChapterRef {
  index: number
  label: string
  href: string
}

export interface BookOpenPayload {
  book: Book
  toc: TocEntry[]
  chapters: ChapterRef[]
  progress: Progress | null
}

export interface ChapterPayload {
  index: number
  label: string
  total: number
  html: string
}

export interface DayStat {
  day: string
  seconds: number
  bookIds: string[]
}

export interface BookStat {
  bookId: string
  seconds: number
  lastAt: number
  percent: number
}

export interface StatsPayload {
  bookCount: number
  finishedCount: number
  totalSeconds: number
  averageSeconds: number
  days: DayStat[]
  books: BookStat[]
  todaySeconds: number
  todayBookId: string | null
  /** 当前在读预计剩余秒数，数据不足时为 null */
  todayRemainingSeconds: number | null
}

export type SyncPhase = 'idle' | 'checking' | 'running' | 'done' | 'error' | 'conflict'

export interface SyncTask {
  id: string
  kind: 'progress' | 'book'
  bookId: string
  title: string
  direction: 'up' | 'down'
  total: number
  done: number
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped'
}

export interface SyncState {
  phase: SyncPhase
  loggedIn: boolean
  account: string | null
  lastSyncAt: number | null
  tasks: SyncTask[]
  transferred: number
  total: number
  message: string | null
}

export interface ConflictItem {
  bookId: string
  title: string
  localPercent: number
  localAt: number
  localDevice: string
  cloudPercent: number
  cloudAt: number
  cloudDevice: string
}

export interface AppInfo {
  version: string
  dataDir: string
  booksDir: string
  coversDir: string
  cacheDir: string
  platform: string
}
