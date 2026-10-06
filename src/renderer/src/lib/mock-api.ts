/**
 * 浏览器预览模式：当 window.api 不存在时（直接用浏览器打开渲染进程），
 * 用内存数据实现同一套接口，便于在无 Electron 环境下查看与评审界面。
 * 数据不落盘，也不代表真实同步行为。
 */
import type {
  AppInfo,
  Book,
  BookOpenPayload,
  ChapterPayload,
  Progress,
  Settings,
  StatsPayload,
  SyncState
} from '@shared/types'

const now = Date.now()
const DAY = 86400000

function dayKey(offsetDays: number): string {
  const d = new Date(now - offsetDays * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const BOOKS: Book[] = [
  {
    id: 'demo-1',
    title: '星海拾遗 01',
    metaTitle: '星海拾遗 第一卷',
    author: '林晚',
    description: '潮汐线以西的观测站已经停摆了十七年。当第一封无人回信被捞起时，所有人都以为那只是洋流的玩笑。',
    format: 'epub',
    fileName: '星海拾遗 01.epub',
    filePath: 'D:/demo/星海拾遗 01.epub',
    fileSize: 3_540_000,
    coverFile: null,
    coverColor: '#3f6d8e',
    chapterCount: 4,
    chapterChars: [8200, 9100, 8700, 9400],
    wordCount: 35400,
    volume: '1',
    seriesKey: '星海拾遗',
    addedAt: now - 12 * DAY,
    lastOpenedAt: now - 3600_000,
    hidden: false,
    syncUpload: false
  },
  {
    id: 'demo-2',
    title: '星海拾遗 02',
    metaTitle: '星海拾遗 第二卷',
    author: '林晚',
    description: '双星之间的静默带里，旧地图最后一次被展开。远处是远日点，也是他们最初出发的地方。',
    format: 'epub',
    fileName: '星海拾遗 02.epub',
    filePath: 'D:/demo/星海拾遗 02.epub',
    fileSize: 3_620_000,
    coverFile: null,
    coverColor: '#6b4a7a',
    chapterCount: 4,
    chapterChars: [8800, 9200, 8600, 9800],
    wordCount: 36400,
    volume: '2',
    seriesKey: '星海拾遗',
    addedAt: now - 9 * DAY,
    lastOpenedAt: now - 2 * DAY,
    hidden: false,
    syncUpload: false
  },
  {
    id: 'demo-3',
    title: '十月书简',
    metaTitle: '十月书简',
    author: '沈迟',
    description: '四封没有寄出的信，从立秋写到霜降。写的人知道收信人不会读到，所以写得格外诚实。',
    format: 'epub',
    fileName: '十月书简.epub',
    filePath: 'D:/demo/十月书简.epub',
    fileSize: 1_980_000,
    coverFile: null,
    coverColor: '#8a5a3c',
    chapterCount: 5,
    chapterChars: [4200, 4600, 3900, 5100, 2600],
    wordCount: 20400,
    volume: null,
    seriesKey: null,
    addedAt: now - 5 * DAY,
    lastOpenedAt: now - 30 * 60_000,
    hidden: false,
    syncUpload: false
  }
]

const CHAPTER_TITLES: Record<string, string[]> = {
  'demo-1': ['第一章 潮汐线', '第二章 观测站', '第三章 无人回信', '第四章 归航'],
  'demo-2': ['第五章 双星', '第六章 静默带', '第七章 旧地图', '第八章 远日点'],
  'demo-3': ['信一 · 立秋', '信二 · 白露', '信三 · 寒露', '信四 · 霜降', '尾聲']
}

const PARAGRAPHS = [
  '十月的风从窗缝里钻进来，翻动了桌上的书页。他把书按住，就着午后那点发白的光，又读了一页。',
  '街道尽头的梧桐落了一地叶子，踩上去会发出干脆的响声。她走过的时候没有回头，只是把围巾往上拉了拉。',
  '“你总说时间不够。”他说，“可时间从来不欠谁，是我们把它花错了地方。”',
  '窗台上的水仙还没开，叶子却已经绿得发亮。屋子里安静得能听见钟表走动的声音，一格，一格。',
  '那些被搁置的信，最后还是寄了出去。信封上的地址已经模糊，邮差看了很久，还是点点头收下了。',
  '雨下了一整夜。清晨推开窗，空气里全是湿润的土腥味，远处的山像被谁用炭笔重新描过一遍。'
]

const progress: Record<string, Progress> = {
  'demo-1': {
    bookId: 'demo-1',
    percent: 0.35,
    chapterIndex: 1,
    chapterTitle: '第二章 观测站',
    scrollRatio: 0.2,
    updatedAt: now - 3600_000,
    deviceId: 'browser-preview',
    rev: 3
  },
  'demo-2': {
    bookId: 'demo-2',
    percent: 1,
    chapterIndex: 3,
    chapterTitle: '第八章 远日点',
    scrollRatio: 0.9,
    updatedAt: now - 2 * DAY,
    deviceId: 'browser-preview',
    rev: 5
  },
  'demo-3': {
    bookId: 'demo-3',
    percent: 0.72,
    chapterIndex: 3,
    chapterTitle: '信四 · 霜降',
    scrollRatio: 0.4,
    updatedAt: now - 30 * 60_000,
    deviceId: 'browser-preview',
    rev: 2
  }
}

const SESSION_SEED: { bookId: string; offsets: number[]; minutes: number }[] = [
  { bookId: 'demo-1', offsets: [0, 1, 3, 6, 9, 12], minutes: 26 },
  { bookId: 'demo-2', offsets: [2, 4, 7, 11], minutes: 18 },
  { bookId: 'demo-3', offsets: [0, 2, 5, 8], minutes: 12 }
]

const sessions = SESSION_SEED.flatMap((seed, si) =>
  seed.offsets.map((offset, i) => ({
    bookId: seed.bookId,
    day: dayKey(offset),
    seconds: (seed.minutes + i * 3 + si * 2) * 60,
    lastAt: now - offset * DAY + 20 * 3600_000
  }))
)

function computeStats(): StatsPayload {
  const days = new Map<string, { day: string; seconds: number; bookIds: string[] }>()
  const books = new Map<string, { bookId: string; seconds: number; lastAt: number; percent: number }>()
  for (const s of sessions) {
    const day = days.get(s.day) ?? { day: s.day, seconds: 0, bookIds: [] }
    day.seconds += s.seconds
    if (!day.bookIds.includes(s.bookId)) day.bookIds.push(s.bookId)
    days.set(s.day, day)

    const item = books.get(s.bookId) ?? {
      bookId: s.bookId,
      seconds: 0,
      lastAt: 0,
      percent: progress[s.bookId]?.percent ?? 0
    }
    item.seconds += s.seconds
    item.lastAt = Math.max(item.lastAt, s.lastAt)
    books.set(s.bookId, item)
  }
  const totalSeconds = sessions.reduce((sum, s) => sum + s.seconds, 0)
  const todayKey = dayKey(0)
  const todaySeconds = sessions.filter((s) => s.day === todayKey).reduce((sum, s) => sum + s.seconds, 0)

  return {
    bookCount: BOOKS.length,
    finishedCount: 1,
    totalSeconds,
    averageSeconds: Math.round(totalSeconds / BOOKS.length),
    days: [...days.values()],
    books: [...books.values()].sort((a, b) => b.lastAt - a.lastAt),
    todaySeconds,
    todayBookId: 'demo-3',
    todayRemainingSeconds: 22 * 60
  }
}

const preview = new URLSearchParams(window.location.search).get('preview') ?? ''
const previewEmpty = preview === 'nobooks'
const previewDark = preview === 'dark'
const previewPaged = preview === 'paged'

const settings: Settings = {
  dataDir: '（浏览器预览模式：数据不会写入磁盘）',
  deviceId: 'browser-preview',
  deviceName: 'DESKTOP-PC',
  theme: previewDark ? 'dark' : 'light',
  librarySort: 'recent',
  dailyGoalMinutes: 30,
  reader: {
    fontSize: 18,
    lineHeight: 1.9,
    fontFamily: 'system',
    pageWidth: 720,
    padding: 36,
    theme: 'paper',
    mode: previewPaged ? 'paged' : 'scroll'
  },
  sync: {
    auto: false,
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

const syncState: SyncState = {
  phase: 'idle',
  loggedIn: false,
  account: null,
  lastSyncAt: null,
  tasks: [],
  transferred: 0,
  total: 0,
  message: '浏览器预览模式：同步引擎未接入'
}

const info: AppInfo = {
  version: '0.1.0-preview',
  dataDir: '浏览器预览模式',
  booksDir: '—',
  coversDir: '—',
  cacheDir: '—',
  platform: 'browser'
}

let currentSettings = settings
let currentProgress = { ...progress }

export function createMockApi(): unknown {
  const chapterHtml = (bookId: string, index: number): string => {
    const title = CHAPTER_TITLES[bookId]?.[index] ?? `第 ${index + 1} 章`
    const body = Array.from({ length: 8 }, (_, i) => `<p>${PARAGRAPHS[(index * 3 + i) % PARAGRAPHS.length]}</p>`).join('')
    return `<h2>${title}</h2>${body}`
  }

  const noop = async (): Promise<never> => {
    throw new Error('浏览器预览模式不支持该操作，请在 Electron 中运行')
  }

  return {
    app: {
      info: async () => info,
      openPath: async () => '',
      pathForFile: () => ''
    },
    settings: {
      get: async () => currentSettings,
      set: async (patch: Partial<Settings>) => {
        currentSettings = {
          ...currentSettings,
          ...patch,
          reader: { ...currentSettings.reader, ...(patch.reader ?? {}) },
          sync: { ...currentSettings.sync, ...(patch.sync ?? {}) }
        }
        return currentSettings
      }
    },
    dialog: {
      chooseFolder: async () => null,
      chooseImage: async () => null,
      confirm: async () => window.confirm('浏览器预览模式：确认执行该操作？')
    },
    library: {
      list: async () => (previewEmpty ? [] : BOOKS),
      importDialog: noop,
      importFolderDialog: noop,
      importPaths: noop,
      remove: noop,
      update: noop,
      reveal: async () => true,
      onChanged: () => () => undefined
    },
    reader: {
      open: async (bookId: string): Promise<BookOpenPayload> => {
        const book = BOOKS.find((b) => b.id === bookId) ?? BOOKS[0]
        const titles = CHAPTER_TITLES[book.id] ?? []
        return {
          book,
          toc: titles.map((label, index) => ({ id: `toc-${index}`, label, chapterIndex: index, level: 0 })),
          chapters: titles.map((label, index) => ({ index, label, href: `chapter${index + 1}.xhtml` })),
          progress: currentProgress[book.id] ?? null
        }
      },
      chapter: async (bookId: string, index: number): Promise<ChapterPayload> => ({
        index,
        label: CHAPTER_TITLES[bookId]?.[index] ?? `第 ${index + 1} 章`,
        total: CHAPTER_TITLES[bookId]?.length ?? 1,
        html: chapterHtml(bookId, index)
      }),
      setProgress: async (bookId: string, patch: Partial<Progress>) => {
        const current = currentProgress[bookId]
        const next: Progress = {
          bookId,
          percent: patch.percent ?? current?.percent ?? 0,
          chapterIndex: patch.chapterIndex ?? current?.chapterIndex ?? 0,
          chapterTitle: patch.chapterTitle ?? current?.chapterTitle ?? '',
          scrollRatio: patch.scrollRatio ?? 0,
          updatedAt: Date.now(),
          deviceId: 'browser-preview',
          rev: (current?.rev ?? 0) + 1
        }
        currentProgress = { ...currentProgress, [bookId]: next }
        return next
      },
      tick: async () => true
    },
    stats: {
      get: async () => computeStats()
    },
    sync: {
      status: async () => syncState,
      connect: async () => syncState,
      run: async () => syncState,
      cancel: async () => syncState,
      downloadAll: async () => syncState,
      conflicts: async () => [],
      resolve: async () => syncState
    }
  }
}
