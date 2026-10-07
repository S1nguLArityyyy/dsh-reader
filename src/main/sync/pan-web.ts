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

import { createHash } from 'node:crypto'
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

  /** 节流：百度对短时间内的密集请求很敏感（坚果云那次就是被打成 503 的） */
  private async pause(ms = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async postForm(path: string, fields: Record<string, string>): Promise<{ status: number; text: string }> {
    const body = new URLSearchParams({
      ...fields,
      bdstoken: await this.ensureToken(),
      channel: 'chunlei',
      web: '1',
      app_id: '250528',
      clienttype: '0'
    }).toString()
    const response = await this.ses().fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    return { status: response.status, text: await response.text() }
  }

  private async ensureToken(): Promise<string> {
    if (this.tokenCache) return this.tokenCache
    const info = await this.templateVariable()
    const token = info?.result?.bdstoken
    if (!token) throw new CloudNotConnectedError('登录已过期：请重新登录百度网盘')
    this.tokenCache = String(token)
    return this.tokenCache
  }

  /** 逐级建目录。errno 0 = 建成功；-8 = 已存在（都算成功） */
  async ensureDir(path: string): Promise<void> {
    const target = normalizeCloudPath(path)
    const segments = target.split('/').filter(Boolean)
    if (segments.length === 0) return
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const { status, text } = await this.postForm('/api/create?a=commit', {
        path: prefix,
        isdir: '1',
        block_list: '[]'
      })
      this.options.log?.(`[pan-web] POST create(dir) ${prefix} → HTTP ${status}  ${text.slice(0, 140)}`)
      if (status !== 200) throw new Error(`建目录失败（HTTP ${status}）：${prefix}`)
      let errno: number | undefined
      try {
        errno = (JSON.parse(text) as { errno?: number }).errno
      } catch {
        throw new Error(`建目录返回无法解析：${text.slice(0, 120)}`)
      }
      if (errno !== 0 && errno !== -8) {
        // -6 / -7 = 登录态问题；132 = 被限流
        if (errno === -6 || errno === -7) throw new CloudNotConnectedError('登录已过期：请重新登录百度网盘')
        if (errno === 132) throw new Error('被百度限流（errno 132）：请稍后再试，本轮已放弃')
        throw new Error(`建目录失败（errno ${errno}）：${prefix}`)
      }
      await this.pause()
    }
  }

  /** 下载：filemetas 拿 dlink → 用同一分区的 cookie 直接 GET（网页会话不需要 access_token） */
  async read(path: string): Promise<Buffer | null> {
    const target = normalizeCloudPath(path)
    const token = await this.ensureToken()
    const url =
      `${BASE}/api/filemetas?${COMMON}&dlink=1&target=${encodeURIComponent(JSON.stringify([target]))}` +
      `&bdstoken=${encodeURIComponent(token)}`
    const { status, text } = await this.fetchText(url)
    this.options.log?.(`[pan-web] GET filemetas ${target} → HTTP ${status}  ${text.slice(0, 140)}`)
    if (status !== 200) return null
    let info: Array<{ dlink?: string }> = []
    try {
      const parsed = JSON.parse(text) as { errno?: number; info?: Array<{ dlink?: string }> }
      if (parsed.errno !== 0) return null
      info = parsed.info ?? []
    } catch {
      return null
    }
    const dlink = info[0]?.dlink
    if (!dlink) return null
    await this.pause(200)
    const response = await this.ses().fetch(dlink, { method: 'GET' })
    this.options.log?.(`[pan-web] GET dlink ${target} → HTTP ${response.status}`)
    if (response.status !== 200) return null
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * 上传（百度网页版的三步）：
   *   ① precreate  → 拿 uploadid
   *   ② superfile2 → 逐片传（4MB 一片）
   *   ③ create     → 落盘
   * 小文件（几 KB 的 JSON）就是"只有一片"的情况，走同一套。
   */
  async write(path: string, data: Buffer): Promise<void> {
    const target = normalizeCloudPath(path)
    const dir = normalizeCloudPath(target.split('/').slice(0, -1).join('/') || '/')
    await this.ensureDir(dir)
    const size = data.byteLength
    const CHUNK = 4 * 1024 * 1024
    const parts: Buffer[] = []
    for (let offset = 0; offset < Math.max(size, 1); offset += CHUNK) {
      parts.push(data.subarray(offset, Math.min(offset + CHUNK, size)))
    }
    const blockList = parts.map((part) => createHash('md5').update(part).digest('hex'))

    // ① precreate
    const pre = await this.postForm('/api/precreate', {
      path: target,
      size: String(size),
      isdir: '0',
      autoinit: '1',
      rtype: '3',
      block_list: JSON.stringify(blockList)
    })
    this.options.log?.(`[pan-web] POST precreate ${target} → HTTP ${pre.status}  ${pre.text.slice(0, 140)}`)
    if (pre.status !== 200) throw new Error(`上传失败（precreate HTTP ${pre.status}）`)
    const preJson = JSON.parse(pre.text) as { errno?: number; uploadid?: string }
    if (preJson.errno !== 0 || !preJson.uploadid) {
      if (preJson.errno === 132) throw new Error('被百度限流（errno 132）：请稍后再试，本轮已放弃')
      throw new Error(`上传失败（precreate errno ${preJson.errno}）`)
    }
    const uploadid = preJson.uploadid

    // ② 分片上传（每片停一下，避免触发风控）
    for (let index = 0; index < parts.length; index += 1) {
      const query =
        `method=upload&type=tmpfile&path=${encodeURIComponent(target)}` +
        `&uploadid=${encodeURIComponent(uploadid)}&partseq=${index}`
      const response = await this.ses().fetch(
        `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?${query}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: parts[index] }
      )
      const text = await response.text()
      this.options.log?.(
        `[pan-web] POST upload ${target} 片${index + 1}/${parts.length} → HTTP ${response.status}  ${text.slice(0, 100)}`
      )
      if (response.status !== 200) throw new Error(`上传失败（分片 ${index + 1} HTTP ${response.status}）`)
      await this.pause(300)
    }

    // ③ commit
    const done = await this.postForm('/api/create?a=commit', {
      path: target,
      size: String(size),
      isdir: '0',
      uploadid,
      block_list: JSON.stringify(blockList)
    })
    this.options.log?.(`[pan-web] POST create(file) ${target} → HTTP ${done.status}  ${done.text.slice(0, 140)}`)
    if (done.status !== 200) throw new Error(`上传失败（create HTTP ${done.status}）`)
    const doneJson = JSON.parse(done.text) as { errno?: number }
    // 0 = 成功；-8 = 已存在（目标存在时 rtype=3 覆盖，这里兜底）
    if (doneJson.errno !== 0 && doneJson.errno !== -8) {
      if (doneJson.errno === -6 || doneJson.errno === -7) {
        throw new CloudNotConnectedError('登录已过期：请重新登录百度网盘')
      }
      throw new Error(`上传失败（create errno ${doneJson.errno}）`)
    }
  }

  async remove(path: string): Promise<void> {
    const target = normalizeCloudPath(path)
    const { status, text } = await this.postForm('/api/filemanager?opera=delete', {
      filelist: JSON.stringify([target])
    })
    this.options.log?.(`[pan-web] POST delete ${target} → HTTP ${status}  ${text.slice(0, 140)}`)
    // 不存在（errno -9）按成功处理：删除是幂等的
    if (status !== 200) throw new Error(`删除失败（HTTP ${status}）`)
    const parsed = JSON.parse(text) as { errno?: number }
    if (parsed.errno !== 0 && parsed.errno !== -9) throw new Error(`删除失败（errno ${parsed.errno}）`)
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