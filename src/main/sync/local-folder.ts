/**
 * 本地文件夹 provider：把本机的一个目录**当成云端**。
 *
 * 用途有两个：
 *  1. 在真实网盘接入之前，让同步引擎（清单 / 双向进度 / 冲突）端到端跑起来并可自动化测试；
 *  2. 兜底通道——目录可以指向网盘客户端的同步目录、局域网共享盘或 U 盘。
 *
 * 语义上刻意贴近网盘：写入是「整体替换」（先写临时文件再改名），
 * 路径一律走云端路径（以 / 开头）并做穿越防护。
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  CloudNotConnectedError,
  CloudPathError,
  normalizeCloudPath,
  type CloudAccount,
  type CloudEntry,
  type CloudProvider
} from './provider'

export interface LocalFolderProviderOptions {
  /** 当前用作「云端」的本机目录；未选择时返回 null */
  getRoot: () => string | null
  /** 交互式选择目录；返回 null 表示用户取消（持久化由调用方负责） */
  chooseRoot: () => Promise<string | null>
}

export class LocalFolderProvider implements CloudProvider {
  readonly id = 'local'
  readonly displayName = '本地文件夹'

  constructor(private readonly options: LocalFolderProviderOptions) {}

  private rootPath(): string {
    const root = this.options.getRoot()
    if (!root || !root.trim()) throw new CloudNotConnectedError('尚未选择本地同步文件夹')
    return resolve(root.trim())
  }

  /** 云端路径 → 磁盘路径；断言结果仍在根目录内（穿越防护的第二道保险） */
  private toDiskPath(cloudPath: string): string {
    const root = this.rootPath()
    const normalized = normalizeCloudPath(cloudPath)
    const target = resolve(root, ...normalized.split('/').filter(Boolean))
    if (target !== root && !target.startsWith(root + sep)) {
      throw new CloudPathError(`云端路径越出了同步文件夹：${cloudPath}`)
    }
    return target
  }

  private toAccount(root: string): CloudAccount {
    return { id: root, name: root, detail: '本机目录（本地文件夹模式）' }
  }

  async connect(): Promise<CloudAccount | null> {
    const picked = await this.options.chooseRoot()
    if (!picked || !picked.trim()) return null
    return this.toAccount(resolve(picked.trim()))
  }

  async account(): Promise<CloudAccount | null> {
    const root = this.options.getRoot()
    if (!root || !root.trim()) return null
    return this.toAccount(resolve(root.trim()))
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(this.toDiskPath(path), { recursive: true })
  }

  async list(dir: string): Promise<CloudEntry[]> {
    const disk = this.toDiskPath(dir)
    if (!existsSync(disk)) return []
    const base = normalizeCloudPath(dir)
    const items = await readdir(disk, { withFileTypes: true })
    const entries: CloudEntry[] = []
    for (const item of items) {
      const info = await stat(join(disk, item.name)).catch(() => null)
      if (!info) continue
      entries.push({
        name: item.name,
        path: normalizeCloudPath(`${base}/${item.name}`),
        kind: info.isDirectory() ? 'dir' : 'file',
        size: info.size,
        modifiedAt: info.mtimeMs
      })
    }
    return entries
  }

  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(this.toDiskPath(path))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** 原子写：先写临时文件再改名，避免读到半截 JSON（网盘替换文件也是这个语义） */
  async write(path: string, data: Buffer): Promise<void> {
    const target = this.toDiskPath(path)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, target)
  }

  async remove(path: string): Promise<void> {
    await rm(this.toDiskPath(path), { recursive: true, force: true })
  }

  async stat(path: string): Promise<CloudEntry | null> {
    const disk = this.toDiskPath(path)
    const normalized = normalizeCloudPath(path)
    const info = await stat(disk).catch(() => null)
    if (!info) return null
    return {
      name: normalized.split('/').filter(Boolean).pop() ?? '',
      path: normalized,
      kind: info.isDirectory() ? 'dir' : 'file',
      size: info.size,
      modifiedAt: info.mtimeMs
    }
  }
}
