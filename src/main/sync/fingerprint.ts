/**
 * 书籍指纹：跨设备对齐「同一本书」。
 *
 * 背景：每台设备导入同一份 EPUB 时生成的 Book.id 是各自的 UUID，两端对不上，
 * 进度就没法按 id 同步。所以云端用**内容指纹**做键：
 *   - 优先 sha1(文件内容)：同一份文件在两端 uuid 不同也能对上；
 *   - 文件缺失 / 不可读时退化成 `title:<归一化书名>`，聊胜于无但要如实标注。
 * 指纹算一次就缓存进 library.json，不必每次同步重算。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import type { Book } from '../../shared/types'
import type { Store } from '../store'

/** 书名归一化：去空白 + 转小写，用于退化匹配 */
export function normalizeTitleKey(title: string): string {
  return String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

/** 云端用来标识「同一本书」的键 */
export function bookSyncKey(book: Book): string {
  return book.contentHash ? `sha1:${book.contentHash}` : `title:${normalizeTitleKey(book.title)}`
}

/** 流式计算文件 sha1（8MB 的书约 20ms，不占内存） */
export function sha1File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 计算一段内存数据的 sha1：从云端下载书籍后校验完整性用 */
export function sha1Buffer(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex')
}

export interface FingerprintResult {  /** 本次算出指纹的数量 */
  computed: number
  /** 已经有指纹、无需重算的数量 */
  cached: number
  /** 文件缺失等原因无法计算的书名 */
  failed: string[]
}

export interface FingerprintOptions {
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}

/** 给「缺指纹且有文件」的书籍补齐内容指纹（首次同步一次性完成） */
export async function ensureContentHashes(
  store: Store,
  options: FingerprintOptions = {}
): Promise<FingerprintResult> {
  const pending = store.books.filter((book) => !book.contentHash && book.filePath && existsSync(book.filePath))
  const failed: string[] = []
  let computed = 0
  let done = 0

  for (const book of pending) {
    if (options.shouldStop?.()) break
    try {
      book.contentHash = await sha1File(book.filePath)
      computed += 1
    } catch {
      failed.push(book.title)
    }
    done += 1
    options.onProgress?.(done, pending.length)
  }

  if (computed > 0) store.save('library')
  return { computed, cached: store.books.length - pending.length, failed }
}
