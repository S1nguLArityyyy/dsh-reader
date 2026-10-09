/** 跨进程共享的数据结构定义（主进程 / preload / 渲染进程共用） */

export type BookFormat = 'epub'

/** 划线颜色 */
export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

/** 划线样式：高亮底色 / 下划线 */
export type AnnotationStyle = 'highlight' | 'underline'

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
  /**
   * 用户手动标记的「已读完」。
   * 主进程从 finished.json 合并进来（那份数据才参与局域网同步），
   * 不写进 library.json。
   */
  finished?: boolean
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

/** 划线 / 笔记：记录一段原文的位置、颜色与备注 */
export interface Annotation {
  id: string
  bookId: string
  chapterIndex: number
  chapterTitle: string
  /** 起点文本块序号（章内，按正文出现顺序） */
  blockIndex: number
  /** 起点所在文本节点序号（块内） */
  tokenIndex: number
  startOffset: number
  /** 终点（含终点字符） */
  endBlockIndex: number
  endTokenIndex: number
  endOffset: number
  /** 选中的原文（最长 160 字），展示与锚点失效时的回退匹配都用它 */
  quote: string
  note: string
  color: AnnotationColor
  style: AnnotationStyle
  createdAt: number
  updatedAt: number
  deviceId: string
  /** 软删除墓碑；列表默认过滤掉，将来手机端同步靠它传递删除 */
  deletedAt?: number
}

/** 新增划线 / 笔记时由渲染进程提供的字段（id / 时间 / 设备由主进程补） */
export interface AnnotationInput {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  blockIndex: number
  tokenIndex: number
  startOffset: number
  endBlockIndex: number
  endTokenIndex: number
  endOffset: number
  quote: string
  note?: string
  color: AnnotationColor
  style: AnnotationStyle
}

/** 修改划线 / 笔记（颜色、样式、备注；带范围字段时同时改位置，重叠裁切用） */
export interface AnnotationPatch {
  color?: AnnotationColor
  style?: AnnotationStyle
  note?: string
  blockIndex?: number
  tokenIndex?: number
  startOffset?: number
  endBlockIndex?: number
  endTokenIndex?: number
  endOffset?: number
  quote?: string
}

/**
 * 书签：记住「读到哪一页」。
 * 定位靠 chapterIndex + scrollRatio，excerpt 只用于展示与跳转校验，不含字内偏移。
 */
export interface Bookmark {
  id: string
  bookId: string
  chapterIndex: number
  chapterTitle: string
  /** 章节内滚动比例 0~1 */
  scrollRatio: number
  /** 由章内位置换算的整书进度 0~1 */
  percent: number
  /** 当前位置的原文摘录（最长 60 字） */
  excerpt: string
  /** 用户备注，可空 */
  note: string
  createdAt: number
  updatedAt: number
  deviceId: string
  /** 软删除墓碑；列表默认过滤掉，将来手机端同步靠它传递删除 */
  deletedAt?: number
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

/** 手机推来的进度与电脑端冲突、等待用户裁决的一项 */
export interface LanConflictItem {
  bookId: string
  title: string
  /** 手机推来的那一份 */
  phonePercent: number
  phoneAt: number
  phoneChapterTitle: string
  /** 电脑端当前的这一份 */
  desktopPercent: number
  desktopAt: number
  desktopChapterTitle: string
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
