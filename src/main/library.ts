import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Book, TocEntry } from '../shared/types'
import type { Store } from './store'
import { extractEpub, readEpubMeta, type EpubMeta } from './epub'
import { splitVolume, titleFromFileName } from './naming'
import { countChapterChars, coverColorOf } from './textstats'
import { percentByPosition } from '../shared/progress'

export { splitVolume }

async function uniqueBookFile(store: Store, id: string): Promise<string> {
  return join(store.booksDir, `${id}.epub`)
}

/** 导入单个 EPUB：复制进书库 -> 解析元数据 -> 抽封面 -> 落库 */
export async function importEpubFile(store: Store, sourcePath: string): Promise<Book> {
  const info = await stat(sourcePath)
  if (!info.isFile()) throw new Error('不是文件')
  if (extname(sourcePath).toLowerCase() !== '.epub') throw new Error('当前版本仅支持 EPUB 格式')

  const id = randomUUID()
  const destPath = await uniqueBookFile(store, id)
  await mkdir(store.booksDir, { recursive: true })
  await copyFile(sourcePath, destPath)

  let meta: EpubMeta
  try {
    meta = await readEpubMeta(destPath)
  } catch (err) {
    await rm(destPath, { force: true })
    throw err
  }

  const fallbackTitle = basename(sourcePath, extname(sourcePath))
  const metaTitle = (meta.title || '').trim()
  // 书名以文件名为准，内部书名仅作回退
  const title = titleFromFileName(fallbackTitle, metaTitle)
  const author = (meta.author || '未知作者').trim()
  const { volume, seriesKey } = splitVolume(title)

  let coverFile: string | null = null
  if (meta.coverData && meta.coverExt) {
    coverFile = join(store.coversDir, `${id}${meta.coverExt}`)
    await writeFile(coverFile, meta.coverData)
  }

  const book: Book = {
    id,
    title,
    metaTitle: metaTitle || title,
    author,
    description: meta.description,
    format: 'epub',
    fileName: basename(sourcePath),
    filePath: destPath,
    fileSize: info.size,
    coverFile,
    coverColor: coverColorOf(coverFile),
    chapterCount: meta.chapterHrefs.length,
    chapterChars: [],
    wordCount: 0,
    volume,
    seriesKey,
    manualSeries: null,
    addedAt: Date.now(),
    lastOpenedAt: null,
    hidden: false,
    syncUpload: false
  }

  // 导入时顺便解压并统计每章字数：既拿到全书进度所需的分母，也让首次打开更快
  await enrichBook(store, book, meta)

  store.books.push(book)
  store.save('library')
  return book
}

/** 补齐封面主色、每章字数、总字数（导入时同步做，旧书由启动后的后台任务补） */
export async function enrichBook(store: Store, book: Book, metaIn?: EpubMeta): Promise<boolean> {
  let changed = false

  if (!book.coverColor && book.coverFile) {
    const color = coverColorOf(book.coverFile)
    if (color) {
      book.coverColor = color
      changed = true
    }
  }

  const needsText = book.chapterChars.length !== book.chapterCount || book.wordCount === 0
  const needsDescription = !book.description
  if (!needsText && !needsDescription) return changed

  try {
    const meta = metaIn ?? (await readEpubMeta(book.filePath))
    if (needsDescription && meta.description) {
      book.description = meta.description
      changed = true
    }
    if (needsText) {
      const cacheDir = await ensureExtracted(store, book)
      const counts = await countChapterChars(cacheDir, meta.opfDir, meta.chapterHrefs)
      book.chapterChars = counts
      book.wordCount = counts.reduce((sum, n) => sum + n, 0)
      book.chapterCount = meta.chapterHrefs.length
      changed = true

      // 字数就绪后，把早期按「章节序号」存的进度改写成按阅读位置的整书进度
      const record = store.progress[book.id]
      if (record) {
        const percent = percentByPosition(
          book.chapterChars,
          book.wordCount,
          record.chapterIndex,
          record.scrollRatio
        )
        if (Math.abs(percent - record.percent) > 0.0005) {
          record.percent = percent
          store.save('progress')
        }
      }
    }
  } catch (err) {
    console.error(`[library] 补齐《${book.title}》信息失败`, err)
  }

  return changed
}

export async function importMany(store: Store, paths: string[]): Promise<{ books: Book[]; errors: string[] }> {
  const books: Book[] = []
  const errors: string[] = []
  for (const p of paths) {
    try {
      books.push(await importEpubFile(store, p))
    } catch (err) {
      errors.push(`${basename(p)}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { books, errors }
}

/** 递归扫描目录中的 EPUB */
export async function scanEpubFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return []
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return out
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await scanEpubFiles(full, depth + 1)))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.epub') {
      out.push(full)
    }
  }
  return out
}

export async function removeBook(store: Store, id: string, deleteFile: boolean): Promise<void> {
  const book = store.books.find((b) => b.id === id)
  if (!book) return
  store.books = store.books.filter((b) => b.id !== id)
  delete store.progress[id]
  store.sessions = store.sessions.filter((s) => s.bookId !== id)
  store.save('library')
  store.save('progress')
  store.save('sessions')
  if (deleteFile) {
    await rm(book.filePath, { force: true })
    if (book.coverFile) await rm(book.coverFile, { force: true })
  }
  await rm(join(store.cacheDir, id), { recursive: true, force: true })
}

/** 打开书籍前确保已解压到缓存目录 */
export async function ensureExtracted(store: Store, book: Book): Promise<string> {
  const dir = join(store.cacheDir, book.id)
  const marker = join(dir, '.extracted')
  if (existsSync(marker)) return dir
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await extractEpub(book.filePath, dir)
  await writeFile(marker, new Date().toISOString(), 'utf8')
  return dir
}

/** 把 EpubMeta 的目录树压平成带 chapterIndex 的列表 */
export function flattenToc(meta: EpubMeta): TocEntry[] {
  const indexByHref = new Map<string, number>()
  meta.chapterHrefs.forEach((href, index) => {
    if (!indexByHref.has(href)) indexByHref.set(href, index)
  })

  const out: TocEntry[] = []
  let seq = 0
  const walk = (nodes: import('../shared/types').TocNode[], level: number): void => {
    for (const node of nodes) {
      const clean = node.href.split('#')[0]
      const chapterIndex = clean ? (indexByHref.get(clean) ?? -1) : -1
      if (node.label || chapterIndex >= 0) {
        out.push({ id: `toc-${seq++}`, label: node.label || `第 ${chapterIndex + 1} 章`, chapterIndex, level })
      }
      if (node.children.length > 0) walk(node.children, level + 1)
    }
  }
  walk(meta.toc, 0)
  return out.filter((e) => e.chapterIndex >= 0)
}

export function bookCacheDir(store: Store, id: string): string {
  return resolve(join(store.cacheDir, id))
}

export function relativeTo(root: string, target: string): string {
  return relative(root, target)
}
