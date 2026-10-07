/**
 * WebDAV provider：标准协议（RFC 4918），不依赖任何网盘的私有接口。
 *
 * 为什么先做这个（对比百度网盘网页接口）：
 *  - 协议稳定：不会因为对方改版而断，坏了也是标准语义问题，好查；
 *  - 实现简单：PROPFIND / MKCOL / PUT / GET / DELETE，没有登录抓 token、没有分片上传、没有风控验证码；
 *  - 免费额度够用：云端只有 KB 级 JSON（坚果云免费版每月上传 1GB / 下载 3GB，用量连 1% 都用不到）。
 *
 * 认证：HTTP Basic，用网盘的「应用密码」（坚果云在网页版「安全选项」里生成，支持两步验证）。
 * 密码不进 settings.json，见 secret-store.ts。
 *
 * 路径口径：与其它 provider 一致，用 / 开头的云端路径；这里负责把它拼成 WebDAV URL
 * （逐段 encodeURIComponent，所以像 `sha1%3A….json` 这种名字存到服务器上仍是原名，不会双重编码）。
 */
import { XMLParser } from 'fast-xml-parser'
import {
  CloudNotConnectedError,
  normalizeCloudPath,
  type CloudAccount,
  type CloudEntry,
  type CloudProvider
} from './provider'

export interface WebDavConfig {
  url: string
  username: string
}

export interface WebDavProviderOptions {
  /** 设置里的连接信息（地址 + 账号）；未配置返回 null */
  getConfig: () => WebDavConfig | null
  /** 应用密码（单独加密存放）；未配置返回 null */
  getPassword: () => string | null
  /** 请求实现：主进程注入 Electron 的 net.fetch（走系统代理），测试注入假实现 */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

interface DavResource {
  href: string
  isDir: boolean
  size: number
  modifiedAt: number
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export class WebDavProvider implements CloudProvider {
  readonly id = 'webdav'
  readonly displayName = 'WebDAV'

  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>
  private readonly timeoutMs: number

  constructor(private readonly options: WebDavProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  /* ---------------- 连接 ---------------- */

  private require(): { config: WebDavConfig; password: string } {
    const config = this.options.getConfig()
    if (!config || !config.url.trim() || !config.username.trim()) {
      throw new CloudNotConnectedError('尚未填写 WebDAV 地址与账号')
    }
    const password = this.options.getPassword()
    if (!password) throw new CloudNotConnectedError('尚未填写 WebDAV 应用密码')
    return { config, password }
  }

  /** 交互式连接：WebDAV 的参数由设置页收集，这里只负责"验证一下能不能通" */
  async connect(): Promise<CloudAccount | null> {
    const { config } = this.require()
    await this.verify()
    return this.accountFrom(config)
  }

  async account(): Promise<CloudAccount | null> {
    const config = this.options.getConfig()
    if (!config || !config.url.trim() || !config.username.trim()) return null
    if (!this.options.getPassword()) return null
    return this.accountFrom(config)
  }

  private accountFrom(config: WebDavConfig): CloudAccount {
    let host = config.url
    try {
      host = new URL(config.url).host
    } catch {
      /* 地址不是标准 URL 时保留原文 */
    }
    return {
      id: `${config.username}@${host}`,
      name: `${config.username} @ ${host}`,
      detail: config.url
    }
  }

  /** 探测一句：根目录 PROPFIND Depth 0，能通就算连上 */
  private async verify(): Promise<void> {
    const response = await this.request('/', { method: 'PROPFIND', depth: '0' })
    if (response.status !== 207 && response.status !== 200) {
      throw new CloudNotConnectedError(`WebDAV 地址不可用（HTTP ${response.status}）`)
    }
  }

  /* ---------------- 目录与文件 ---------------- */

  /** 逐级 MKCOL；405 = 已存在，按 RFC 视为正常 */
  async ensureDir(path: string): Promise<void> {
    const segments = normalizeCloudPath(path).split('/').filter(Boolean)
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const response = await this.request(prefix, { method: 'MKCOL' })
      if (response.status !== 201 && response.status !== 405 && response.status !== 301 && response.status !== 302) {
        throw new Error(`创建目录失败 ${prefix}：HTTP ${response.status}`)
      }
    }
  }

  async list(dir: string): Promise<CloudEntry[]> {
    const normalized = normalizeCloudPath(dir)
    const { config } = this.require()
    // 请求路径也归一化成 pathname，用来把"目录自己"那条 response 过滤掉
    const selfPath = this.hrefPath(this.toUrl(normalized, config)).replace(/\/+$/, '')

    const response = await this.request(normalized, { method: 'PROPFIND', depth: '1' })
    if (response.status === 404) return []
    if (response.status !== 207) throw new Error(`列目录失败 ${normalized}：HTTP ${response.status}`)

    const entries: CloudEntry[] = []
    for (const resource of this.parseMultiStatus(await response.text())) {
      const resourcePath = resource.href.replace(/\/+$/, '')
      if (!resourcePath || resourcePath === selfPath) continue
      const rawName = resourcePath.split('/').filter(Boolean).pop()
      if (!rawName) continue
      const name = decodeURIComponent(rawName)
      entries.push({
        name,
        path: normalizeCloudPath(`${normalized}/${name}`),
        kind: resource.isDir ? 'dir' : 'file',
        size: resource.size,
        modifiedAt: resource.modifiedAt
      })
    }
    return entries
  }

  async read(path: string): Promise<Buffer | null> {
    const normalized = normalizeCloudPath(path)
    // 先问一句大小：书可能是几 MB，按量估超时，别用 20 秒的小文件超时去下书
    const info = await this.stat(normalized)
    if (!info) return null
    return await this.withRetry(async () => {
      const response = await this.request(normalized, { method: 'GET', timeoutMs: this.timeoutFor(info.size) })
      if (response.status === 404) return null
      if (response.status !== 200) throw new Error(`读取失败 ${normalized}：HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    })
  }

  async write(path: string, data: Buffer): Promise<void> {
    const normalized = normalizeCloudPath(path)
    await this.withRetry(async () => {
      const response = await this.request(normalized, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(data),
        timeoutMs: this.timeoutFor(data.byteLength)
      })
      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        throw new Error(`写入失败 ${normalized}：HTTP ${response.status}`)
      }
    })
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizeCloudPath(path)
    const response = await this.request(normalized, { method: 'DELETE' })
    // 404 当成已删除（幂等），引擎可能重复调用
    if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
      throw new Error(`删除失败 ${normalized}：HTTP ${response.status}`)
    }
  }

  async stat(path: string): Promise<CloudEntry | null> {
    const normalized = normalizeCloudPath(path)
    const response = await this.request(normalized, { method: 'PROPFIND', depth: '0' })
    if (response.status === 404) return null
    if (response.status !== 207) throw new Error(`查询失败 ${normalized}：HTTP ${response.status}`)
    const [resource] = this.parseMultiStatus(await response.text())
    if (!resource) return null
    const rawName = resource.href.replace(/\/+$/, '').split('/').filter(Boolean).pop()
    return {
      name: rawName ? decodeURIComponent(rawName) : '',
      path: normalized,
      kind: resource.isDir ? 'dir' : 'file',
      size: resource.size,
      modifiedAt: resource.modifiedAt
    }
  }

  /* ---------------- 内部 ---------------- */

  private async request(
    cloudPath: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array; depth?: string; timeoutMs?: number }
  ): Promise<Response> {
    const { config, password } = this.require()
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${password}`, 'utf8').toString('base64')}`
    headers['User-Agent'] = headers['User-Agent'] ?? 'DshReader/0.1 (WebDAV)'
    if (init.depth) headers.Depth = init.depth

    const bytes = init.body ? init.body.byteLength : 0
    const startedAt = Date.now()
    const label = `${init.method} ${cloudPath}${bytes > 0 ? ` (${Math.round(bytes / 1024)}KB)` : ''}`
    void logSync(`→ ${label}`)
    let response: Response
    try {
      response = await this.fetchImpl(this.toUrl(cloudPath, config), {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs)
      })
    } catch (error) {
      void logSync(`✗ ${label}  ${Date.now() - startedAt}ms  ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    void logSync(`← ${label}  HTTP ${response.status}  ${Date.now() - startedAt}ms`)
    if (response.status === 401 || response.status === 403) {
      throw new CloudNotConnectedError(`WebDAV 认证失败（HTTP ${response.status}）：请检查账号与应用密码`)
    }
    return response
  }

  /**
   * 按数据量估超时：小 JSON 用 20 秒就够，几 MB 的书按 50KB/s 的下限放宽，
   * 最多 10 分钟 —— 否则慢速上行传书必被自己的超时掐断。
   */
  private timeoutFor(sizeBytes: number): number {
    const estimated = Math.ceil(sizeBytes / 50_000) * 1000 + 15_000
    return Math.min(10 * 60_000, Math.max(this.timeoutMs, estimated))
  }

  /** 读写都是幂等的，失败重试两次（1 秒 / 3 秒退避）；认证失败不重试 */
  private async withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await run()
      } catch (err) {
        lastError = err
        if (err instanceof CloudNotConnectedError) throw err
        void logSync(`↻ 第 ${attempt} 次失败，准备重试：${err instanceof Error ? err.message : String(err)}`)
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 1000 : 3000))
      }
    }
    throw lastError
  }

  private toUrl(cloudPath: string, config: WebDavConfig): string {
    const base = config.url.trim().replace(/\/+$/, '')
    const segments = normalizeCloudPath(cloudPath)
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
    return segments.length > 0 ? `${base}/${segments.join('/')}` : `${base}/`
  }

  private hrefPath(href: string): string {
    const raw = String(href ?? '')
    try {
      return new URL(raw, 'http://dav.invalid').pathname
    } catch {
      return raw
    }
  }

  private parseMultiStatus(xml: string): DavResource[] {
    let doc: Record<string, any>
    try {
      doc = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml)
    } catch {
      return []
    }
    const resources: DavResource[] = []
    for (const response of toArray<any>(doc?.multistatus?.response)) {
      const href = String(response?.href ?? '')
      if (!href) continue
      const propstats = toArray<any>(response?.propstat)
      const props = (propstats.length > 0 ? propstats[0]?.prop : response?.prop) ?? {}
      const modified = Date.parse(String(props?.getlastmodified ?? ''))
      resources.push({
        href: this.hrefPath(href),
        isDir: this.isCollection(props?.resourcetype, href),
        size: Number(props?.getcontentlength ?? 0) || 0,
        modifiedAt: Number.isFinite(modified) ? modified : 0
      })
    }
    return resources
  }

  private isCollection(resourcetype: unknown, href: string): boolean {
    // 真服务器：目录是 <resourcetype><collection/></resourcetype>（解析成对象），
    // 文件是 <resourcetype/>（解析成空串）。所以只有"对象且带 collection"才算目录，
    // 空串不能算 —— 否则文件会被当成目录。实在没有 resourcetype 时退回看 href 结尾。
    if (resourcetype && typeof resourcetype === 'object') {
      return 'collection' in (resourcetype as Record<string, unknown>)
    }
    return href.endsWith('/')
  }
}

/**
 * 同步调试日志：写到 <userData>/logs/sync.log。
 * 排查"同步卡在哪一步"用 —— 每条请求都有 方法 / 路径 / 状态码 / 耗时 / 字节数。
 * 用动态 import 拿 electron 与 fs，避免动顶部的导入块。
 */
export async function logSync(line: string): Promise<void> {
  try {
    const { app } = await import('electron')
    const { appendFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = join(app.getPath('userData'), 'logs')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'sync.log'), `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 日志失败绝不能影响同步本身 */
  }
}

/** 给用户看的日志路径 */
export function syncLogPath(): string {
  return 'logs/sync.log（在应用数据目录下）'
}