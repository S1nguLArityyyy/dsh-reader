import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfo,
  Book,
  BookOpenPayload,
  ChapterPayload,
  ConflictItem,
  Progress,
  Settings,
  StatsPayload,
  SyncState
} from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

export interface ImportResult {
  books: Book[]
  errors: string[]
}

const api = {
  app: {
    info: () => invoke<AppInfo>('app:info'),
    /** 把主窗口隐藏到托盘（局域网服务继续运行） */
    hideToTray: () => invoke<boolean>('app:hideToTray'),
    /** 是否已设置开机自启（状态读自系统） */
    getAutoLaunch: () => invoke<boolean>('app:getAutoLaunch'),
    /** 设置开机自启，返回设置后的真实状态 */
    setAutoLaunch: (enabled: boolean) => invoke<boolean>('app:setAutoLaunch', enabled),
    openPath: (target: string) => invoke<string>('shell:openPath', target),
    /** 拖拽导入时把浏览器 File 还原成本地绝对路径 */
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  settings: {
    get: () => invoke<Settings>('settings:get'),
    set: (patch: Partial<Settings>) => invoke<Settings>('settings:set', patch)
  },
  dialog: {
    chooseFolder: () => invoke<string | null>('dialog:chooseFolder'),
    chooseImage: () => invoke<string | null>('dialog:chooseImage'),
    confirm: (options: {
      title: string
      message: string
      detail?: string
      confirmText?: string
      danger?: boolean
    }) => invoke<boolean>('dialog:confirm', options)
  },
  appearance: {
    /** 选背景图并复制进数据目录，返回可直接用的路径 */
    pickBackdrop: (kind: 'app' | 'reader') => invoke<string | null>('appearance:pickBackdrop', kind)
  },
  library: {
    list: () => invoke<Book[]>('library:list'),
    importDialog: () => invoke<ImportResult>('library:importDialog'),
    importFolderDialog: () => invoke<ImportResult>('library:importFolderDialog'),
    importPaths: (paths: string[]) => invoke<ImportResult>('library:importPaths', paths),
    remove: (id: string, deleteFile: boolean) => invoke<Book[]>('library:remove', id, deleteFile),
    /** 只清除阅读记录（进度 + 时长），书保留 */
    clearRecords: (id: string) => invoke<Book[]>('library:clearRecords', id),
    clearAllRecords: () => invoke<Book[]>('library:clearAllRecords'),
    update: (id: string, patch: Partial<Book>) => invoke<Book[]>('library:update', id, patch),
    /** 批量标记「同步到云端」 */
    markSyncUpload: (value: boolean) => invoke<Book[]>('library:markSyncUpload', value),
    reveal: (id: string) => invoke<boolean>('library:reveal', id),
    /** 后台补齐书籍信息后主进程会通知刷新 */
    onChanged: (callback: () => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('library:changed', listener)
      return () => {
        ipcRenderer.removeListener('library:changed', listener)
      }
    }
  },
  reader: {
    open: (bookId: string) => invoke<BookOpenPayload>('reader:open', bookId),
    chapter: (bookId: string, index: number) => invoke<ChapterPayload>('reader:chapter', bookId, index),
    setProgress: (bookId: string, patch: Partial<Progress>) => invoke<Progress>('reader:progress', bookId, patch),
    tick: (bookId: string, seconds: number) => invoke<boolean>('reader:tick', bookId, seconds)
  },
  lan: {
    reloadRecords: () => invoke<boolean>('lan:reloadRecords'),
    openBooksDir: () => invoke<string>('lan:openBooksDir'),
    /** 主进程收到手机推来的记录后会通知刷新 */
    onChanged: (callback: () => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('sync:changed', listener)
      return () => {
        ipcRenderer.removeListener('sync:changed', listener)
      }
    }
  },
  stats: {
    get: () => invoke<StatsPayload>('stats:get')
  },
}

export type DshApi = typeof api

contextBridge.exposeInMainWorld('api', api)
