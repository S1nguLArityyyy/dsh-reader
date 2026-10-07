/**
 * 百度网盘 provider（阶段 1：应用内登录 + 会话持久化 + 列目录）。
 *
 * 路线：**不走开放平台 API**，而是在应用内打开登录页（扫码 / 短信验证码），
 * 复用网页会话（cookie）去调网页接口。
 *
 * 会话怎么持久化：用 Electron 的独立分区 `persist:pan-login` ——
 * 登录一次 cookie 就写进磁盘，重启应用依然登录着；之后所有请求都走
 * 同一个分区的 `session.fetch()`，cookie 自动带上（这正是这条路线最省事的地方）。
 *
 * 阶段规划：
 *   阶段 1（本文件当前）account / list                        ← 只读，可验证
 *   阶段 2              write / read / remove（三步分片上传） ← 见 docs/内嵌登录网盘方案.md
 *   阶段 3              接进 engine，与 WebDAV 的云端格式互通
 */

import { BrowserWindow, session } from 'electron'
import {
  CloudNotConnectedError,
  normalizeCloudPath,
  type CloudAccount,
  type CloudEntry,
  type CloudProvider
} from './provider'

const PARTITION = 'persist:pan-login'
const BASE = 'https://pan.baidu.com'
/** 网页接口的公共参数（缺了会返回 errno:2 之类的参数错误） */
const COMMON = 'channel=chunlei&web=1&app_id=250528&clienttype=0'

export interface PanWebOptions {
  log?: (line: string) => void
  /** 打开登录窗；测试可注入假实现 */
  openLoginWindow?: () => Promise<BrowserWindow>
}

interface TemplateVariable {
  errno?: number
  result?: { uk?: number | string; bdstoken?: string }
}

interface ListItem {
  server_filename: string
  isdir: number | string
  size?: number
  server_mtime?: number
  path: string
}

interface ListResponse {
  errno?: number
  list?: ListItem[]
}

export class PanWebProvider implements CloudProvider {
  readonly id = 'baidu'
  readonly displayName = '百度网盘'
  private tokenCache: string | null = null

  constructor(private readonly options: PanWebOptions = {}) {}

  private ses(): Electron.Session {
    return session.fromPartition(PARTITION)
  }

  /** 统一走登录分区的 fetch：cookie 由 Electron 自动带上 */
  private async fetchText(url: string): Promise<{ status: number; text: string }> {
    const response = await this.ses().fetch(url, { method: 'GET' })
    return { status: response.status, text: await response.text() }
  }

  private async templateVariable(): Promise<TemplateVariable | null> {
    const url = `${BASE}/api/gettemplatevariable?${COMMON}&fields=${encodeURIComponent('["uk","bdstoken"]')}`
    const { status, text } = await this.fetchText(url)
    this.options.log?.(`[pan-web] GET gettemplatevariable → HTTP ${status}  ${text.slice(0, 120)}`)
    if (status !== 200) return null
    try {
      const parsed = JSON.parse(text) as TemplateVariable
      if (parsed.errno !== 0 || !parsed.result) return null
      if (parsed.result.bdstoken) this.tokenCache = String(parsed.result.bdstoken)
      return parsed
    } catch {
      return null
    }
  }

  /** 只读探测登录态：拿得到 uk 就算登录着 */
  async account(): Promise<CloudAccount | null> {
    const info = await this.templateVariable()
    const uk = info?.result?.uk
    if (uk === undefined || uk === null || String(uk) === '') return null
    return { id: String(uk), name: `百度网盘 · ${uk}`, detail: '应用内登录（网页会话）' }
  }

  /** 打开登录窗并等用户完成登录 */
  async connect(): Promise<CloudAccount | null> {
    const before = await this.account().catch(() => null)
    if (before) return before

    const open = this.options.openLoginWindow ?? (() => openLoginWindow(this.options.log))
    const win = await open()
    const deadline = Date.now() + 5 * 60_000
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        if (win.isDestroyed()) break
        const account = await this.account().catch(() => null)
        if (account) {
          this.options.log?.(`[pan-web] 登录成功：${account.name}`)
          return account
        }
      }
      this.options.log?.('[pan-web] 登录窗超时或已关闭')
      return null
    } finally {
      if (!win.isDestroyed()) win.close()
    }
  }

  async list(dir: string): Promise<CloudEntry[]> {
    const path = normalizeCloudPath(dir)
    const token = this.tokenCache ?? (await this.templateVariable())?.result?.bdstoken ?? ''
    const url =
      `${BASE}/api/list?${COMMON}&order=name&desc=0&showempty=0&page=1&num=1000` +
      `&dir=${encodeURIComponent(path)}&bdstoken=${encodeURIComponent(String(token))}`
    const { status, text } = await this.fetchText(url)
    this.options.log?.(`[pan-web] GET list ${path} → HTTP ${status}  ${text.slice(0, 120)}`)
    if (status !== 200) throw new CloudNotConnectedError(`列目录失败（HTTP ${status}）：登录可能已过期`)
    const parsed = JSON.parse(text) as ListResponse
    if (parsed.errno !== 0) {
      // errno -6 / -7 都是登录态问题；-9 是目录不存在（按空目录处理）
      if (parsed.errno === -9) return []
      throw new CloudNotConnectedError(`列目录失败（errno ${parsed.errno}）：请重新登录百度网盘`)
    }
    return (parsed.list ?? []).map((item) => {
      const isDir = String(item.isdir) === '1'
      return {
        name: item.server_filename,
        path: normalizeCloudPath(item.path),
        kind: isDir ? 'dir' : 'file',
        size: Number(item.size ?? 0),
        modifiedAt: Number(item.server_mtime ?? 0) * 1000
      } as CloudEntry
    })
  }

  async stat(path: string): Promise<CloudEntry | null> {
    const target = normalizeCloudPath(path)
    const parent = normalizeCloudPath(target.split('/').slice(0, -1).join('/') || '/')
    const name = target.split('/').filter(Boolean).pop() ?? ''
    const entries = await this.list(parent)
    return entries.find((entry) => entry.name === name) ?? null
  }

  /* ---------------- 阶段 2 才实现（现在明确报错，不静默失败） ---------------- */

  async ensureDir(): Promise<void> {
    throw new Error('百度网盘上传依赖的三步分片接口属阶段 2，尚未实现')
  }

  async read(): Promise<Buffer | null> {
    throw new Error('百度网盘下载属阶段 2，尚未实现')
  }

  async write(): Promise<void> {
    throw new Error('百度网盘上传属阶段 2，尚未实现')
  }

  async remove(): Promise<void> {
    throw new Error('百度网盘删除属阶段 2，尚未实现')
  }
}

/** 打开登录窗（独立分区：cookie 会持久化到磁盘） */
async function openLoginWindow(log?: (line: string) => void): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 520,
    height: 780,
    title: '登录百度网盘',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await win.loadURL(`${BASE}/`)
  log?.('[pan-web] 已打开登录窗：请扫码或用短信验证码登录（登录后本窗口会自动关闭）')
  return win
}