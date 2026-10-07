/**
 * 同步服务（IPC 层的门面）。
 *
 * 职责很薄：按设置选择 provider、持有同步引擎、维持一份给界面看的 SyncState，
 * 把既有 IPC 通道转到引擎上。真正的同步逻辑在 engine.ts；
 * 各种「云端」的实现各自一个文件：local-folder.ts（本机目录）、webdav.ts（标准协议）、
 * 以后接百度网盘时再加一个，engine 一行都不用改。
 */
import { app, dialog, net } from 'electron'
import { join } from 'node:path'
import type { ConflictItem, SyncState } from '../../shared/types'
import type { Store } from '../store'
import { SyncEngine } from './engine'
import { LocalFolderProvider } from './local-folder'
import type { CloudProvider } from './provider'
import { createSecretStore, type SecretStore } from './secret-store'
import { WebDavProvider } from './webdav'

export interface SyncServiceOptions {
  /** 选择云端目录；默认弹系统目录选择框，测试里注入固定目录 */
  chooseDirectory?: () => Promise<string | null>
  /** 可注入的时钟，便于测试冲突窗口 */
  now?: () => number
  log?: (message: string) => void
  /** 一轮同步跑完后回调（通知界面刷新：进度 / 今日阅读 / 统计都可能变了） */
  onChanged?: () => void
  /** WebDAV 的请求实现；默认用 Electron 的 net.fetch（走系统代理） */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** 应用密码的存放；默认加密存到 <数据目录>/sync/webdav-secret.json */
  secretStore?: SecretStore
}

export interface WebDavConnectPayload {
  url: string
  username: string
  /** 留空表示沿用已保存的应用密码（密码不回传渲染进程，所以要留空就代表不改） */
  password?: string
}

async function chooseDirectoryDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择用作「云端」的文件夹',
    buttonLabel: '用作同步目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class SyncService {
  private state: SyncState = {
    phase: 'idle',
    loggedIn: false,
    account: null,
    lastSyncAt: null,
    tasks: [],
    transferred: 0,
    total: 0,
    message: null
  }

  private conflicts: ConflictItem[] = []
  private readonly store: Store
  private readonly engine: SyncEngine
  private readonly secrets: SecretStore
  private readonly options: SyncServiceOptions
  private readonly onChanged?: () => void
  /** 按类型缓存 provider 实例（切换云端类型时各自独立） */
  private readonly providers = new Map<string, CloudProvider>()

  constructor(store: Store, options: SyncServiceOptions = {}) {
    this.store = store
    this.options = options
    this.onChanged = options.onChanged
    this.secrets = options.secretStore ?? createSecretStore(join(store.syncDir, 'webdav-secret.json'))

    this.engine = new SyncEngine({
      store,
      // provider 取函数：设置里切换云端类型时不需要重建引擎
      provider: () => this.provider(),
      remoteDir: () => this.store.settings.sync.remoteDir || '/DshReader',
      conflictPolicy: () => this.store.settings.sync.conflictPolicy,
      appVersion: app.getVersion(),
      now: options.now,
      log: options.log,
      onState: (state) => {
        this.state = state
      }
    })

    // 读一次上次同步时间，界面不必等第一次同步才有值
    void this.engine.hydrate()
  }

  /* ---------------- provider 选择 ---------------- */

  private provider(): CloudProvider {
    const id = this.store.settings.sync.provider
    const cached = this.providers.get(id)
    if (cached) return cached
    // 百度网盘尚未接入：未知类型一律按本地文件夹处理，避免设置被改坏时整个同步不可用
    const created = id === 'webdav' ? this.createWebDav() : this.createLocal()
    this.providers.set(id, created)
    return created
  }

  private createLocal(): CloudProvider {
    return new LocalFolderProvider({
      getRoot: () => this.store.settings?.sync?.localCloudDir ?? null,
      chooseRoot: async () => {
        const picked = await (this.options.chooseDirectory ?? chooseDirectoryDialog)()
        if (!picked) return null
        this.store.settings.sync.provider = 'local'
        this.store.settings.sync.localCloudDir = picked
        this.store.save('settings', true)
        return picked
      }
    })
  }

  private createWebDav(): CloudProvider {
    return new WebDavProvider({
      getConfig: () => {
        const config = this.store.settings.sync.webdav
        if (!config || !config.url.trim() || !config.username.trim()) return null
        return { url: config.url, username: config.username }
      },
      getPassword: () => this.secrets.load(),
      fetchImpl: this.options.fetch ?? ((input, init) => net.fetch(input, init))
    })
  }

  /* ---------------- 对外接口 ---------------- */

  /** 连接状态以 provider 实际配置为准，避免启动顺序或外部改动让界面撒谎 */
  async status(): Promise<SyncState> {
    const account = await this.provider().account().catch(() => null)
    return { ...this.state, loggedIn: Boolean(account), account: account ? account.name : null }
  }

  pendingConflicts(): ConflictItem[] {
    return this.conflicts
  }

  /** 连接：本地文件夹 = 选目录；WebDAV = 用已保存的信息验证一句 */
  async connect(): Promise<SyncState> {
    try {
      const account = await this.provider().connect()
      if (!account) {
        this.state = { ...this.state, message: '已取消连接' }
        return this.status()
      }
    } catch (err) {
      this.state = { ...this.state, phase: 'error', message: messageOf(err) }
      return this.status()
    }
    return this.run()
  }

  async run(): Promise<SyncState> {
    const result = await this.engine.run()
    this.conflicts = result.conflicts
    this.notifyChanged()
    return this.status()
  }

  async cancel(): Promise<SyncState> {
    this.engine.cancel()
    return this.status()
  }

  /** 全部下载：忽略冲突判定，一律以云端为准 */
  async downloadAll(): Promise<SyncState> {
    const result = await this.engine.run({ preferCloud: true })
    this.conflicts = []
    this.notifyChanged()
    return this.status()
  }

  /** 冲突弹窗的选择：本轮按它取舍，随后照常推进同步时间 */
  async resolve(_items: ConflictItem[], choice: 'local' | 'cloud'): Promise<SyncState> {
    const result = await this.engine.run({ policyOverride: choice })
    this.conflicts = result.conflicts
    this.notifyChanged()
    return this.status()
  }

  /**
   * 保存 WebDAV 连接信息并立刻验证 + 同步一次。
   * 密码只在主进程里流转：渲染进程提交后就不再持有，也不回传。
   */
  async configureWebdav(payload: WebDavConnectPayload): Promise<SyncState> {
    const url = String(payload?.url ?? '').trim()
    const username = String(payload?.username ?? '').trim()
    const password = typeof payload?.password === 'string' ? payload.password : ''

    this.store.settings.sync.provider = 'webdav'
    this.store.settings.sync.webdav = { url, username }
    this.store.save('settings', true)
    this.providers.delete('webdav') // 配置变了，缓存里那份还拿着旧地址

    // 密码写不进磁盘（沙箱 / 只读盘）不算致命：内存里已经有了，本次运行照常能用
    let warning: string | null = null
    if (password) {
      try {
        this.secrets.save(password)
      } catch (err) {
        warning = messageOf(err)
      }
    }

    if (!url || !username) {
      this.state = { ...this.state, phase: 'error', message: '请填写 WebDAV 地址与账号' }
      return this.status()
    }
    if (!this.secrets.load()) {
      this.state = { ...this.state, phase: 'error', message: '请填写 WebDAV 应用密码' }
      return this.status()
    }

    const state = await this.connect()
    if (warning) {
      this.state = {
        ...this.state,
        message: `${this.state.message ? `${this.state.message}；` : ''}${warning}`
      }
      return this.status()
    }
    return state
  }

  /** 退出登录：清掉应用密码（地址与账号保留，方便重填） */
  async logout(): Promise<SyncState> {
    this.secrets.clear()
    this.providers.clear()
    this.state = {
      ...this.state,
      phase: 'idle',
      loggedIn: false,
      account: null,
      tasks: [],
      transferred: 0,
      total: 0,
      message: '已退出登录，应用密码已清除'
    }
    return this.status()
  }

  /** 同步跑完通知界面刷新（进度 / 今日阅读 / 统计都可能变了） */
  private notifyChanged(): void {
    this.onChanged?.()
  }
}
