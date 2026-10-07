/**
 * WebDAV 应用密码的存放。
 *
 * 原则：**绝不写进 settings.json** —— 那是会被导出、分享、贴到 issue 里的文件。
 * 密码存在 `<数据目录>/sync/webdav-secret.json`，优先用系统凭据加密
 * （Windows 上是 DPAPI，macOS 钥匙串，Linux 视桌面环境而定）；
 * 拿不到加密能力时退化成明文，并在文件里如实标注 encrypted:false。
 *
 * 解不开（换了机器 / 换了 Windows 账户）时当作"没配置过"，提示重新填密码，而不是崩掉。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export interface SecretStore {
  load(): string | null
  save(value: string): void
  has(): boolean
  clear(): void
}

/** 密码写不进磁盘（沙箱限制 / 只读盘）：调用方据此提示，但本次运行仍可用内存里的值 */
export class SecretWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretWriteError'
  }
}

interface SecretFile {
  schema: number
  /** true = value 是系统凭据加密后的 base64；false = 明文（退化情形） */
  encrypted: boolean
  value: string
}

export function createSecretStore(filePath: string): SecretStore {
  let cached: string | null | undefined

  const read = (): string | null => {
    if (cached !== undefined) return cached
    cached = null
    try {
      if (!existsSync(filePath)) return cached
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as SecretFile
      if (!parsed || typeof parsed.value !== 'string') return cached
      if (parsed.encrypted) {
        try {
          cached = safeStorage.decryptString(Buffer.from(parsed.value, 'base64'))
        } catch {
          cached = null
        }
      } else {
        cached = parsed.value
      }
    } catch {
      cached = null
    }
    return cached
  }

  return {
    load: read,
    has: () => read() !== null,
    save(value: string): void {
      const encrypted = safeStorage.isEncryptionAvailable()
      const payload: SecretFile = {
        schema: 1,
        encrypted,
        value: encrypted ? safeStorage.encryptString(value).toString('base64') : value
      }
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.tmp`
        writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
        renameSync(tmp, filePath)
      } catch (err) {
        // 写不进去时不要只丢一个 EPERM 给用户：本次运行先放内存里，连接照样能用，
        // 只是重启后需要重填 —— 如实说明原因。
        cached = value
        const reason = err instanceof Error ? err.message : String(err)
        throw new SecretWriteError(
          `应用密码写不进磁盘（${filePath}），已改为只在本次运行内记住：重启后需要重新填写。原因：${reason}`
        )
      }
      cached = value
    },
    clear(): void {
      try {
        rmSync(filePath, { force: true })
      } catch {
        /* 删不掉也不能让「退出登录」失败 */
      }
      cached = null
    }
  }
}
