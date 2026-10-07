/**
 * 云端存储抽象（CloudProvider）——把「网盘」收敛成一个接口。
 *
 * 为什么要这一层：既定路线是「应用内登录网盘 + 复用网页接口传递信息」，
 * 这类非公开接口随时可能因对方改版而失效。把易碎的部分关在 provider 里，
 * 同步引擎只认接口，将来换网盘 / 换官方 API / 换 WebDAV 只改一个文件。
 *
 * 路径口径：provider 一律使用以 / 开头的云端路径（如 /DshReader/progress/x.json），
 * 与真实网盘的目录习惯一致，由各 provider 自己映射到底层（本地目录 / 网页接口）。
 * 归一化会拒绝 `..` 穿越、盘符与空段，这是安全边界。
 */

export interface CloudEntry {
  /** 文件名（不含目录） */
  name: string
  /** 归一化后的云端绝对路径 */
  path: string
  kind: 'file' | 'dir'
  size: number
  modifiedAt: number
}

export interface CloudAccount {
  id: string
  name: string
  detail?: string
}

/** 云端路径非法（穿越、盘符、非法字符等） */
export class CloudPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudPathError'
  }
}

/** 尚未建立云端连接 */
export class CloudNotConnectedError extends Error {
  constructor(message = '尚未连接云端') {
    super(message)
    this.name = 'CloudNotConnectedError'
  }
}

/** 云端存储的最小能力集：列出 / 读写 / 建目录 / 删除 / 取连接状态 */
export interface CloudProvider {
  readonly id: string
  readonly displayName: string
  /** 交互式建立连接（选目录 / 登录）；返回 null 表示用户取消 */
  connect(): Promise<CloudAccount | null>
  /** 只读当前连接状态，不弹窗、无副作用 */
  account(): Promise<CloudAccount | null>
  ensureDir(path: string): Promise<void>
  list(dir: string): Promise<CloudEntry[]>
  /** 读取文件；文件不存在时返回 null（不是错误） */
  read(path: string): Promise<Buffer | null>
  write(path: string, data: Buffer): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<CloudEntry | null>
}

/** 归一化云端路径：允许相对写法，但拒绝 `..` 穿越、盘符与空字符 */
export function normalizeCloudPath(input: string): string {
  const raw = String(input ?? '')
    .replace(/\\/g, '/')
    .trim()
  if (!raw) return '/'
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') throw new CloudPathError(`云端路径不允许包含 ..：${input}`)
    if (segment.includes(':')) throw new CloudPathError(`云端路径不允许包含盘符：${input}`)
    if (segment.includes('\0')) throw new CloudPathError(`云端路径包含非法字符：${input}`)
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/** 拼接云端路径（各段会先归一化，因此不需要调用方关心多余斜杠） */
export function joinCloudPath(base: string, ...rest: (string | null | undefined)[]): string {
  const head = String(base ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
  const tail = rest
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
  return normalizeCloudPath([head, ...tail].join('/'))
}

/**
 * 云端文件名：把任意键（如 `sha1:<hex>`、书名）编码成合法文件名。
 * Windows 不允许文件名里出现 `:`，所以统一编码；读取时用 decode 还原。
 */
export function cloudFileName(key: string, ext = '.json'): string {
  return `${encodeURIComponent(key)}${ext}`
}

export function cloudKeyFromFileName(name: string, ext = '.json'): string {
  const raw = name.endsWith(ext) ? name.slice(0, -ext.length) : name
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
