/**
 * 把一批 EPUB 导入「正式书库」（走 App 自己的导入管线：解析元数据、抽封面、统计每章字数）。
 *
 * 目录约定与便携版一致：
 *   书   → exe 旁的 books\        （默认 D:\DshReaderApp\books，可用 DSH_BOOKS_DIR 覆盖）
 *   数据 → %APPDATA%\Dsh Reader   （可用 DSH_DATA_DIR 覆盖）
 *
 * 用法：node scripts/import-books.mjs <EPUB 目录>
 *       （也可以用环境变量 DSH_IMPORT_DIR 指定）
 * 注意：导入前先关掉 Dsh Reader，避免两边同时写 library.json。
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Store } from '../src/main/store'
import { importMany } from '../src/main/library'

// 源目录必须显式给出：以前这里写死了作者本机的路径，公开仓库里不该出现
const sourceArg = (process.argv[2] ?? process.env.DSH_IMPORT_DIR ?? '').trim()
if (!sourceArg) {
  console.error('用法：node scripts/import-books.mjs <EPUB 目录>\n（也可用环境变量 DSH_IMPORT_DIR 指定）')
  process.exit(1)
}
const source = resolve(sourceArg)
const dataDir = resolve(process.env.DSH_DATA_DIR ?? join(process.env.APPDATA ?? '.', 'Dsh Reader'))
const booksDir = resolve(process.env.DSH_BOOKS_DIR ?? 'D:\\DshReaderApp\\books')
// Store 从环境变量读书籍目录，必须在构造之前设好
process.env.DSH_BOOKS_DIR = booksDir

if (!existsSync(source)) {
  console.error(`源目录不存在：${source}`)
  process.exit(1)
}

const files = readdirSync(source)
  .filter((name) => name.toLowerCase().endsWith('.epub'))
  .sort()
  .map((name) => join(source, name))

if (files.length === 0) {
  console.error(`源目录里没有 EPUB：${source}`)
  process.exit(1)
}

console.log(`源目录　：${source}`)
console.log(`数据目录：${dataDir}`)
console.log(`书籍目录：${booksDir}`)
console.log(`待导入　：${files.length} 本\n`)

const store = new Store(dataDir)
await store.init()

// 同名书已在库里就跳过，重复执行不会灌一堆副本
const existing = new Set(store.books.map((book) => book.fileName))
const todo = files.filter((file) => !existing.has(basename(file)))
const skipped = files.length - todo.length
if (skipped > 0) console.log(`书库里已有同名书，跳过 ${skipped} 本`)

const started = Date.now()
const result = await importMany(store, todo)

for (const book of result.books) {
  const size = Math.round((book.fileSize / 1024 / 1024) * 10) / 10
  const words = Math.round((book.wordCount / 10000) * 10) / 10
  console.log(`  ✓ ${book.title}　${book.author}　${book.chapterCount} 章 / ${words} 万字　${size}MB`)
}
for (const error of result.errors) console.log(`  ✗ ${error}`)

console.log(
  `\n完成：成功 ${result.books.length} 本，失败 ${result.errors.length} 本，用时 ${Math.round((Date.now() - started) / 1000)} 秒`
)
console.log(`书库现在共 ${store.books.length} 本`)
