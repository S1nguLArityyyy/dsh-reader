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
    confirm: (options: {
      title: string
      message: string
      detail?: string
      confirmText?: string
      danger?: boolean
    }) => invoke<boolean>('dialog:confirm', options)
  },
  library: {
    list: () => invoke<Book[]>('library:list'),
    importDialog: () => invoke<ImportResult>('library:importDialog'),
    importFolderDialog: () => invoke<ImportResult>('library:importFolderDialog'),
    importPaths: (paths: string[]) => invoke<ImportResult>('library:importPaths', paths),
    remove: (id: string, deleteFile: boolean) => invoke<Book[]>('library:remove', id, deleteFile),
    update: (id: string, patch: Partial<Book>) => invoke<Book[]>('library:update', id, patch),
    reveal: (id: string) => invoke<boolean>('library:reveal', id)
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
    resolve: (items: ConflictItem[], choice: 'local' | 'cloud') => invoke<SyncState>('sync:resolve', items, choice)
  }
}

export type DshApi = typeof api

contextBridge.exposeInMainWorld('api', api)
