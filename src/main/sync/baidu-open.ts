/**
 * 百度网盘 provider（开放平台 xpan + OAuth，oob 模式）。
 *
 * 为什么换成这条路：网页会话路线在**下载**上撞墙 —— /api/download 需要网页签名 sign，
 * 而该签名不在任何 API 响应里（实测 sign=n/ts=y → 31362 sign error），前端页面又是 JS 壳抓不到。
 * 参照一个能正常下载的第三方阅读器（其 dex/dart 里只有 access_token/oauth/xpan，没有 bdstoken/sign3）
 * 可以确认：**开放平台 + access_token 才是可行的下载通道**。
 *
 * 本文件当前实现：授权（oob）→ 换 token → 续期 → 用户信息 → 列目录。
 * 上传/下载在后续步骤补（端点见 docs/百度网盘开放平台方案.md）。
 *
 * 安全：SecretKey 只在本文件（主进程）使用，绝不下发到渲染层，也不写进仓库。
 */

import { app, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CloudNotConnectedError,
  normalizeCloudPath,
  type CloudAccount,
  type CloudEntry,
  type CloudProvider
} from './provider'

const OAUTH = 'https://openapi.baidu.com/oauth/2.0'
const XPAN = 'https://pan.baidu.com/rest/2.0/xpan'

export interface BaiduOpenOptions {
  appKey: string
  secretKey: string
  /** 应用专属目录名（= 开放平台里的应用名） */
  appName?: string
  log?: (line: string) => void
  openAuthWindow?: (url: string) => Promise<BrowserWindow>
}

interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export class BaiduOpenProvider implements CloudProvider {
  readonly id = 'baidu'
  readonly displayName = '百度网盘'
  private token: TokenSet | null = null
  private uk = ''

  constructor(private readonly options: BaiduOpenOptions) {}

  /** 应用专属目录：开放平台应用只能访问 /apps/<应用名>/ */
  private root(): string {
    const name = (this.options.appName ?? '阅读器').trim()
    return `/apps/${name}`
  }

  private tokenFile(): string {
    return join(app.getPath('userData'), 'baidu-token.json')
  }

  private async loadToken(): Promise<TokenSet | null> {
    if (this.token) return this.token
    try {
      const raw = await readFile(this.tokenFile(), 'utf8')
      const parsed = JSON.parse(raw) as TokenSet
      if (parsed.accessToken) {
        this.token = parsed
        return parsed
      }
    } catch {
      /* 没有就是没授权过 */
    }
    return null
  }

  private async saveToken(token: TokenSet): Promise<void> {
    this.token = token
    try {
      await writeFile(this.tokenFile(), JSON.stringify(token), 'utf8')
    } catch {
      /* 存不下也不致命，本次运行内可用 */
    }
  }

  /** access_token 过期时自动用 refresh_token 续期（用户无感） */
  private async accessToken(): Promise<string> {
    const token = await this.loadToken()
    if (!token) throw new CloudNotConnectedError('尚未授权百度网盘：请点「连接」完成授权')
    if (token.expiresAt > Date.now() + 60_000) return token.accessToken
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: this.options.appKey,
      client_secret: this.options.secretKey
    }).toString()
    const response = await fetch(`${OAUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    const json = (await response.json()) as Record<string, unknown>
    if (!json.access_token) {
      throw new CloudNotConnectedError('百度网盘授权已失效：请点「连接」重新授权')
    }
    const next: TokenSet = {
      accessToken: String(json.access_token),
      refreshToken: String(json.refresh_token ?? token.refreshToken),
      expiresAt: Date.now() + Number(json.expires_in ?? 2592000) * 1000
    }
    await this.saveToken(next)
    this.options.log?.('[baidu] access_token 已自动续期 ✓')
    return next.accessToken
  }

  private async call<T>(url: string, init?: { method?: string; body?: string }): Promise<T> {
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: init?.body
    })
    const text = await response.text()
    this.options.log?.(`[baidu] ${init?.method ?? 'GET'} ${url.split('?')[0]} → HTTP ${response.status}  ${text.slice(0, 160)}`)
    if (!response.ok) throw new Error(`百度接口失败（HTTP ${response.status}）`)
    return JSON.parse(text) as T
  }

  /** 授权：打开 oob 授权页 → 读出页面上的 code → 换 token */
  async connect(): Promise<CloudAccount | null> {
    const existing = await this.account().catch(() => null)
    if (existing) return existing
    const url =
      `${OAUTH}/authorize?response_type=code&client_id=${encodeURIComponent(this.options.appKey)}` +
      `&redirect_uri=oob&scope=basic,netdisk&display=page`
    const open =
      this.options.openAuthWindow ??
      ((target: string) =>
        Promise.resolve(
          new BrowserWindow({
            width: 520,
            height: 760,
            title: '授权百度网盘',
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false }
          })
        ).then(async (win) => {
          await win.loadURL(target)
          return win
        }))
    const win = await open(url)
    this.options.log?.('[baidu] 已打开授权页：登录并点「授权」后页面会显示一串 code')
    const code = await readCodeFromWindow(win)
    if (!win.isDestroyed()) win.close()
    if (!code) return null
    this.options.log?.(`[baidu] 读到授权码（${code.length} 位）`)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.options.appKey,
      client_secret: this.options.secretKey,
      redirect_uri: 'oob'
    }).toString()
    const response = await fetch(`${OAUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    const json = (await response.json()) as Record<string, unknown>
    if (!json.access_token) {
      this.options.log?.(`[baidu] 换 token 失败：${JSON.stringify(json).slice(0, 200)}`)
      return null
    }
    await this.saveToken({
      accessToken: String(json.access_token),
      refreshToken: String(json.refresh_token ?? ''),
      expiresAt: Date.now() + Number(json.expires_in ?? 2592000) * 1000
    })
    return this.account()
  }

  /** 只读探测：已授权且能拿到用户名 */
  async account(): Promise<CloudAccount | null> {
    try {
      const token = await this.accessToken()
      const info = await this.call<{ errno?: number; baidu_name?: string; netdisk_name?: string; uk?: number }>(
        `${XPAN}/nas?method=uinfo&access_token=${encodeURIComponent(token)}`
      )
      if (info.errno !== 0) return null
      this.uk = String(info.uk ?? '')
      return {
        id: this.uk || 'baidu',
        name: `百度网盘 · ${info.baidu_name ?? info.netdisk_name ?? this.uk}`,
        detail: this.root()
      }
    } catch {
      return null
    }
  }

  async list(dir: string): Promise<CloudEntry[]> {
    const token = await this.accessToken()
    const path = normalizeCloudPath(dir)
    const body = await this.call<{ errno?: number; list?: Array<Record<string, unknown>> }>(
      `${XPAN}/file?method=list&order=name&desc=0&limit=1000&access_token=${encodeURIComponent(token)}` +
        `&dir=${encodeURIComponent(path)}`
    )
    if (body.errno !== 0) return []
    return (body.list ?? []).map((item) => ({
      name: String(item.server_filename ?? ''),
      path: normalizeCloudPath(String(item.path ?? '')),
      kind: String(item.isdir ?? '0') === '1' ? 'dir' : 'file',
      size: Number(item.size ?? 0),
      modifiedAt: Number(item.server_mtime ?? 0) * 1000
    }))
  }

  async stat(path: string): Promise<CloudEntry | null> {
    const target = normalizeCloudPath(path)
    const parent = normalizeCloudPath(target.split('/').slice(0, -1).join('/') || '/')
    const name = target.split('/').filter(Boolean).pop() ?? ''
    const entries = await this.list(parent).catch(() => [])
    return entries.find((entry) => entry.name === name) ?? null
  }

  /* ---------------- 后续步骤实现（明确报错，不静默失败） ---------------- */

  /** 逐级建目录（xpan create）。先查再建：百度对已存在目录会自动改名，不能盲目建 */
  async ensureDir(path: string): Promise<void> {
    const token = await this.accessToken()
    const target = normalizeCloudPath(path)
    const segments = target.split('/').filter(Boolean)
    if (segments.length === 0) return
    let prefix = ''
    for (const segment of segments) {
      prefix = `${prefix}/${segment}`
      const existing = await this.stat(prefix).catch(() => null)
      if (existing) continue
      const body = new URLSearchParams({ path: prefix, isdir: '1', access_token: token }).toString()
      const created = await this.call<{ errno?: number }>(`${XPAN}/file?method=create`, {
        method: 'POST',
        body
      })
      // 0 = 建成功；-8 = 已存在（都算成功）
      if (created.errno !== 0 && created.errno !== -8) {
        if (created.errno === -6 || created.errno === -7) {
          throw new CloudNotConnectedError('百度网盘授权已失效：请点「连接」重新授权')
        }
        throw new Error(`建目录失败（errno ${created.errno}）：${prefix}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  /** 用目录列表拿到文件的 fs_id（xpan 的 filemetas 需要它，而不是路径） */
  private async fsidOf(path: string): Promise<string> {
    const token = await this.accessToken()
    const target = normalizeCloudPath(path)
    const parent = normalizeCloudPath(target.split('/').slice(0, -1).join('/') || '/')
    const name = target.split('/').filter(Boolean).pop() ?? ''
    const body = await this.call<{ errno?: number; list?: Array<Record<string, unknown>> }>(
      `${XPAN}/file?method=list&limit=1000&access_token=${encodeURIComponent(token)}` +
        `&dir=${encodeURIComponent(parent)}`
    )
    if (body.errno !== 0) return ''
    const hit = (body.list ?? []).find((item) => String(item.server_filename ?? '') === name)
    return hit ? String(hit.fs_id ?? '') : ''
  }

  /**
   * 下载。
   *
   * ★ 关键一步：`GET <dlink>&access_token=…` ★
   * 网页会话路线就是死在这里（缺网页签名 sign → 403 / 31362），
   * 而开放平台用 access_token 取内容是完全合法的 ✓（参照那个能正常下载的阅读器 ✓）。
   */
  async read(path: string): Promise<Buffer | null> {
    const token = await this.accessToken()
    const fsid = await this.fsidOf(path)
    if (!fsid) return null
    const meta = await this.call<{ errno?: number; info?: Array<Record<string, unknown>> }>(
      `${XPAN}/multimedia?method=filemetas&dlink=1&access_token=${encodeURIComponent(token)}` +
        `&fsids=${encodeURIComponent(JSON.stringify([Number(fsid)]))}`
    )
    const dlink = meta.info?.[0]?.dlink
    if (!dlink) return null
    const response = await fetch(`${String(dlink)}&access_token=${encodeURIComponent(token)}`)
    this.options.log?.(`[baidu] GET dlink → HTTP ${response.status}  ${path}`)
    if (!response.ok) return null
    return Buffer.from(await response.arrayBuffer())
  }

  async write(): Promise<void> {
    throw new Error('百度开放平台上传属下一步实现')
  }

  async remove(): Promise<void> {
    throw new Error('百度开放平台删除属下一步实现')
  }
}

/** 从授权页读出 code（oob 模式：页面直接显示一串授权码） */
async function readCodeFromWindow(win: BrowserWindow): Promise<string> {
  const deadline = Date.now() + 5 * 60_000
  const dumpFile = join(app.getPath('userData'), 'baidu-auth-page.txt')
  let lastDump = ''
  // innerText 读不到 input/textarea 的值 —— 而 oob 授权码常放在只读输入框里（用户给的码是 32 位 hex）
  const script = [
    '(() => {',
    '  const parts = []',
    '  if (document.body) parts.push(document.body.innerText || "")',
    '  document.querySelectorAll("input,textarea").forEach((el) => { if (el.value) parts.push(el.value) })',
    '  parts.push(document.documentElement ? document.documentElement.outerHTML.slice(0, 20000) : "")',
    '  return parts.join("\\n---\\n")',
    '})()'
  ].join('\n')
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    if (win.isDestroyed()) return ''
    const text = String(await win.webContents.executeJavaScript(script).catch(() => ''))
    if (text && text !== lastDump) {
      lastDump = text
      try {
        await writeFile(dumpFile, text, 'utf8')
      } catch {
        /* 忽略 */
      }
    }
    // 真正的授权码是 32 位十六进制、且页面里只有一个这样的串（已用转储文件验证过）—— 必须优先精确匹配，
    // 否则宽泛模式会先抓到旁边无关的短串（实测抓到过 20 位的 → invalid_grant）
    const matched =
      /\b([0-9a-f]{32})\b/i.exec(text) ??
      /(?:授权码|请复制)[^\w]{0,20}([A-Za-z0-9_-]{20,120})/.exec(text)
    if (matched) return matched[1]
  }
  return ''
}
