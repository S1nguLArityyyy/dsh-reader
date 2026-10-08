/** 跨进程共享的数据结构定义（主进程 / preload / 渲染进程共用） */

export type BookFormat = 'epub'

/** 书库中的一本书 */
export interface Book {
  id: string
  /** 展示用书名：以文件名为准，文件名不可读时回退到 EPUB 内部书名 */
  title: string
  /** EPUB 元数据里的书名（dc:title），详情页里对照显示 */
  metaTitle: string
  author: string
  format: BookFormat
  fileName: string
  /** 书库内副本的绝对路径 */
  filePath: string
  fileSize: number
  /**
   * 文件内容的 sha1（跨设备对齐「同一本书」用）。
   * 老数据为 null，首次同步时按需补齐并缓存回 library.json。
   */
  contentHash: string | null
  /** 封面文件绝对路径，解析失败时为 null */
  coverFile: string | null
  /** 封面主色（#rrggbb），用于卡片渐变 */
  coverColor: string | null
  /** 书籍简介（来自 dc:description） */
  description: string
  chapterCount: number
  /** 每章可见字符数，用于按阅读位置计算进度 */
  chapterChars: number[]
  /** 全书字数（各章之和） */
  wordCount: number
  /** 卷号，如 "9"；无卷号时为 null */
  volume: string | null
  /** 同系列归组键（去掉卷号后的书名） */
  seriesKey: string | null
  /** 用户手动指定的合集名，优先于自动归组 */
  manualSeries: string | null
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

/** 按「书 + 天 + 设备」聚合的阅读会话（同步时每台设备各存一条，展示时相加） */
export interface SessionRow {
  id: string
  bookId: string
  /** YYYY-MM-DD（本地时区） */
  day: string
  seconds: number
  firstAt: number
  lastAt: number
  /** 这条时长来自哪台设备；老数据为空表示本机 */
  deviceId?: string
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
  /**
   * 云端类型：
   *  - local：本机目录当云端（用于测试与单机兜底）
   *  - webdav：标准协议，坚果云等（应用密码走 HTTP Basic）
   *  - baidu：应用内登录百度网盘（路线已定，尚未接入）
   */
  /** provider = local 时用作「云端」根目录的本机路径；未选择为 null */
  localCloudDir: string | null
  /** provider = webdav 时的连接信息（应用密码单独加密存放，不在这里） */
  /** 自动同步开关 */
  auto: boolean
  /** 退出阅读（合上书）时立刻同步一次：进度与阅读时长 */
  onReaderClose: boolean
  intervalMinutes: number
  /** 网盘中的同步文件夹 */
  remoteDir: string
  conflictPolicy: 'ask' | 'local' | 'cloud'
  /** 书籍本体同步总开关（默认关；打开后按每本书的 Book.syncUpload 勾选上传） */
  uploadBooks: boolean
  /** 云端出现本机没有的书时自动下载（默认关，避免悄悄吃流量） */
  autoDownloadBooks: boolean
}

export interface AppearanceSettings {
  /** 主题色（#rrggbb） */
  accent: string
  /** 应用背景图绝对路径，为空表示用默认背景 */
  backgroundImage: string | null
  /** 阅读器背景图绝对路径 */
  readerBackgroundImage: string | null
  /** 背景图不透明度 0~1 */
  backgroundOpacity: number
}

export interface Settings {
  dataDir: string
  deviceId: string
  deviceName: string
  theme: 'light' | 'dark'
  librarySort: 'recent' | 'added' | 'title'
  /** 每日阅读目标（分钟），用于「今日阅读进度」 */
  dailyGoalMinutes: number
  reader: ReaderSettings
  sync: SyncSettings
  appearance: AppearanceSettings
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
  kind: 'progress' | 'book' | 'stats'
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
  /** 局域网服务地址（形如 http://192.168.0.102:8787），未启动为空串 */
  lanUrl: string
  /** 最近一次收到手机推来的阅读记录 */
  lastRecordPush: { at: number; progress: number; sessions: number }
  /** 正在发送给手机的书；没有则为 null */
  lanTransfer: { name: string; sent: number; total: number } | null
}
