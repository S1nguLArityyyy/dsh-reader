/** EPUB 解析自检脚本（由 scripts/epub-check.mjs 打包后运行） */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractEpub, readChapter, readEpubMeta } from '../src/main/epub'
import { flattenToc, splitVolume } from '../src/main/library'

const samplesDir = process.argv[2] ?? join(process.cwd(), 'samples')
const files = readdirSync(samplesDir).filter((f) => f.toLowerCase().endsWith('.epub'))
if (files.length === 0) {
  console.error('samples 目录下没有 EPUB，请先运行 npm run samples')
  process.exit(1)
}

const toUrl = (abs: string): string => `dsh://media/${encodeURIComponent(abs)}`
let failures = 0

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const file of files) {
  const full = join(samplesDir, file)
  console.log(`\n=== ${file} ===`)
  const meta = await readEpubMeta(full)

  check('书名', meta.title.length > 0, meta.title)
  check('作者', true, meta.author || '（无作者信息，应用会回退为「未知作者」）')
  check('卷号识别', true, JSON.stringify(splitVolume(meta.title)))
  check('章节数 > 0', meta.chapterHrefs.length > 0, `${meta.chapterHrefs.length} 章`)
  check('封面已提取', Boolean(meta.coverData && meta.coverData.byteLength > 1000), `${meta.coverData?.byteLength ?? 0} 字节 ${meta.coverExt ?? ''}`)
  check('目录条目 > 0', meta.toc.length > 0, `${meta.toc.length} 条`)

  const toc = flattenToc(meta)
  check('目录可映射到章节', toc.length > 0, toc.map((t) => `${t.label}→${t.chapterIndex}`).join(' / '))

  const cache = mkdtempSync(join(tmpdir(), 'dsh-epub-'))
  try {
    await extractEpub(full, cache)

    // 逐章读取：全部都要能读出来，并且至少有一章是实质正文
    let readable = 0
    let substantial = 0
    let sample = ''
    let sanitizeChecked = false
    let sanitizeOk = true
    for (let i = 0; i < meta.chapterHrefs.length; i += 1) {
      const chapter = await readChapter(cache, meta.opfDir, meta.chapterHrefs[i], toUrl)
      const plain = chapter.html.replace(/<[^>]*>/g, '').trim()
      readable += 1
      if (plain.length > 200) {
        substantial += 1
        if (!sample) sample = plain.slice(0, 60)
        if (!sanitizeChecked) {
          sanitizeChecked = true
          sanitizeOk =
            !/<(script|style|link)\b/i.test(chapter.html) &&
            !/\son[a-z]+\s*=/i.test(chapter.html) &&
            !/src\s*=\s*"(?!dsh:|https?:|data:)/i.test(chapter.html)
        }
      }
    }
    check('所有章节均可读取', readable === meta.chapterHrefs.length, `${readable}/${meta.chapterHrefs.length}`)
    check('存在实质正文章节', substantial > 0, `${substantial} 章正文 > 200 字`)
    check('正文净化（脚本/事件属性/相对路径均已处理）', !sanitizeChecked || sanitizeOk)
    if (sample) console.log(`    正文片段：${sample}…`)
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
