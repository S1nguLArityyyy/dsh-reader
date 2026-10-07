/**
 * 把一本书导出成手机端可直接 fetch 的静态数据 —— 数据层第 1 步。
 *
 *   public/data/library.json   书籍元数据 + 目录 + 每章正文 HTML
 *   public/data/cover.jpg      封面
 *   public/data/media/*        正文引用到的图片
 *
 * 用的是桌面端**已经跑通的解析器**（readEpubMeta / extractEpub / readChapter / sanitizeChapter），
 * 所以这一步不碰"解析器移植"，先把「真目录 + 真正文 + 真封面」的渲染链路打通。
 *
 * 用法：node scripts/export-mobile-data.mjs <EPUB 路径> [输出目录]
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { extractEpub, readChapter, readEpubMeta } from '../src/main/epub'
import { flattenToc } from '../src/main/library'

const bookPath = resolve(process.argv[2] ?? '')
const outRoot = resolve(process.argv[3] ?? 'D:\\DshReaderMobile\\public\\data')
const workDir = resolve('.test/export-work')

if (!bookPath || !existsSync(bookPath)) {
  console.error('用法：node scripts/export-mobile-data.mjs <EPUB 路径> [输出目录]')
  process.exit(1)
}

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
mkdirSync(outRoot, { recursive: true })
mkdirSync(join(outRoot, 'media'), { recursive: true })

console.log(`源文件：${bookPath}`)
console.log('解析元数据…')
const meta = await readEpubMeta(bookPath)
console.log(`  书名：${meta.title || '(空)'}　作者：${meta.author || '(空)'}`)
console.log(`  spine 章节数：${meta.chapterHrefs.length}　目录条目：${meta.toc.length}`)

console.log('解压…')
await extractEpub(bookPath, workDir)

// 目录里的标题按 href 建索引，正文标题优先用目录里的
const tocLabels = new Map<string, string>()
for (const entry of flattenToc(meta)) {
  if (entry.href && entry.label) tocLabels.set(entry.href.split('#')[0], entry.label)
}

// 正文图片：复制到 media/ 并返回相对地址（相对于页面 URL，浏览器与 Capacitor 都能取到）
const copiedMedia = new Map<string, string>()
const copyMedia = (absPath: string): string => {
  if (!existsSync(absPath)) return ''
  const cached = copiedMedia.get(absPath)
  if (cached) return cached
  const name = `${copiedMedia.size + 1}${extname(absPath) || '.bin'}`
  copyFileSync(absPath, join(outRoot, 'media', name))
  const url = `data/media/${name}`
  copiedMedia.set(absPath, url)
  return url
}

console.log('导出章节…')
const chapters: Array<{ index: number; label: string; html: string }> = []
for (const [index, href] of meta.chapterHrefs.entries()) {
  const plainHref = href.split('#')[0]
  const chapter = await readChapter(workDir, meta.opfDir, href, copyMedia)
  const label = tocLabels.get(plainHref) || chapter.title || `第 ${index + 1} 章`
  chapters.push({ index, label, html: chapter.html })
  if ((index + 1) % 5 === 0) console.log(`  已导出 ${index + 1}/${meta.chapterHrefs.length}`)
}

// 封面
let coverFile = ''
if (meta.coverData && meta.coverExt) {
  coverFile = `data/cover${meta.coverExt}`
  writeFileSync(join(outRoot, `cover${meta.coverExt}`), meta.coverData)
}

const wordCount = chapters.reduce((total, chapter) => {
  const text = chapter.html.replace(/<[^>]+>/g, '')
  return total + text.replace(/\s+/g, '').length
}, 0)

const library = {
  exportedAt: new Date().toISOString(),
  book: {
    id: 'real-1',
    title: basename(bookPath, extname(bookPath)),
    metaTitle: meta.title,
    author: meta.author || '未知作者',
    description: meta.description,
    format: 'epub',
    fileName: basename(bookPath),
    filePath: '',
    coverFile,
    chapterCount: chapters.length,
    wordCount,
    toc: meta.toc
  },
  chapters
}

writeFileSync(join(outRoot, 'library.json'), JSON.stringify(library), 'utf8')

const size = statSync(join(outRoot, 'library.json')).size
console.log('\n导出完成：')
console.log(`  章节：${chapters.length}　字数：${(wordCount / 10000).toFixed(1)} 万　图片：${copiedMedia.size} 张`)
console.log(`  library.json：${(size / 1048576).toFixed(2)}MB　封面：${coverFile || '无'}`)
console.log(`  输出目录：${outRoot}`)
