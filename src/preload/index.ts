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
    update: (id: string, patch: Partial<Book>) => invoke<Book[]>('library:update', id, patch),
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
  stats: {
    get: () => invoke<StatsPayload>('stats:get')
  },
  sync: {
    status: () => invoke<SyncState>('sync:status'),
    connect: () => invoke<SyncState>('sync:connect'),
    run: () => invoke<SyncState>('sync:run'),
    cancel: () => invoke<SyncState>('sync:cancel'),
    downloadAll: () => invoke<SyncState>('sync:downloadAll'),
    conflicts: () => invoke<ConflictItem[]>('sync:conflicts'),
    resolve: (items: ConflictItem[], choice: 'local' | 'cloud') => invoke<SyncState>('sync:resolve', items, choice),
    /** 保存 WebDAV 连接信息并立刻验证 + 同步（密码只进主进程，不回传） */
    configureWebdav: (payload: { url: string; username: string; password?: string }) =>
      invoke<SyncState>('sync:configureWebdav', payload),
    /** 退出登录：清掉已保存的应用密码 */
    logout: () => invoke<SyncState>('sync:logout'),
    /** 退出阅读时通知主进程顺手同步一次（不等待结果） */
    afterReading: () => invoke<void>('sync:afterReading'),
    /** 同步跑完（含自动同步）后主进程会通知刷新：进度 / 今日阅读 / 统计都可能变了 */
    onChanged: (callback: () => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('sync:changed', listener)
      return () => {
        ipcRenderer.removeListener('sync:changed', listener)
      }
    }
  }
}

export type DshApi = typeof api

contextBridge.exposeInMainWorld('api', api)
