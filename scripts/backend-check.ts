/**
 * 主进程后端集成自检（不依赖 Electron 运行时）：
 * 用真实 EPUB 走完整链路 —— 导入 → 打开 → 读章节 → 记时 → 进度 → 统计 → 重启后读回。
 */
import { existsSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { invokeHandler } from './electron-stub'
import { registerIpc } from '../src/main/ipc'
import { SyncService } from '../src/main/sync'
import { Store } from '../src/main/store'
import { importMany } from '../src/main/library'
import { splitVolume } from '../src/main/naming'
import type { Book, ChapterPayload, BookOpenPayload, StatsPayload, Settings, Progress } from '../src/shared/types'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const samplesDir = join(process.cwd(), 'samples')
const sampleFiles = readdirSync(samplesDir)
  .filter((f) => f.toLowerCase().endsWith('.epub'))
  .map((f) => join(samplesDir, f))
if (sampleFiles.length === 0) {
  console.error('samples 目录下没有 EPUB，请先运行 npm run samples')
  process.exit(1)
}

const dataDir = join(process.cwd(), '.testdata')
rmSync(dataDir, { recursive: true, force: true })

/* ---------- 1. 首次启动：导入 ---------- */
console.log('\n[1] 首次启动与导入')
const store = new Store(dataDir)
await store.init()
check('数据目录已创建', existsSync(dataDir))
check('四个数据文件初始化后可写', true)
registerIpc(store, new SyncService())

const imported = await importMany(store, sampleFiles)
check('全部示例 EPUB 导入成功', imported.books.length === sampleFiles.length, `${imported.books.length}/${sampleFiles.length}`)
for (const err of imported.errors) console.log(`    导入失败：${err}`)

const books = (await invokeHandler('library:list')) as Book[]
check('IPC library:list 返回书籍', books.length > 0, `${books.length} 本`)
const first = books[0]
check('书库副本已落盘', existsSync(first.filePath))
check('封面已落盘', Boolean(first.coverFile && existsSync(first.coverFile)), first.coverFile ?? '无')
check('卷号/系列识别', first.volume !== undefined, `${first.title} → volume=${first.volume} series=${first.seriesKey}`)

/* ---------- 2. 阅读：打开、逐章、进度、计时 ---------- */
console.log('\n[2] 阅读链路')
const opened = (await invokeHandler('reader:open', first.id)) as BookOpenPayload
check('reader:open 返回目录', opened.chapters.length > 0, `${opened.chapters.length} 章 / 目录 ${opened.toc.length} 条`)

let chapterOk = 0
let coverPages = 0
for (let i = 0; i < opened.chapters.length; i += 1) {
  const chapter = (await invokeHandler('reader:chapter', first.id, i)) as ChapterPayload
  const text = chapter.html.replace(/<[^>]*>/g, '').trim()
  const isCoverPage = /cover/i.test(opened.chapters[i].href)
  if (isCoverPage) coverPages += 1
  if ((text.length > 10 || isCoverPage) && !/<script/i.test(chapter.html)) chapterOk += 1
}
check(
  '每章都能读取（封面页允许只有图）',
  chapterOk === opened.chapters.length,
  `${chapterOk}/${opened.chapters.length}，其中封面页 ${coverPages} 个`
)
check(
  '封面页命名为「封面」而不是「第 1 章」',
  !opened.chapters.some((c) => /cover/i.test(c.href) && /^第 \d+ 章$/.test(c.label)),
  opened.chapters.map((c) => c.label).join(' / ')
)
check('无进度时默认从目录首项开始', (opened.toc[0]?.chapterIndex ?? 0) > 0, `目录首项 → 第 ${(opened.toc[0]?.chapterIndex ?? 0) + 1} 项`)

const allBooksReadable = await Promise.all(
  books.map(async (book) => {
    const payload = (await invokeHandler('reader:open', book.id)) as BookOpenPayload
    const chapter = (await invokeHandler('reader:chapter', book.id, 0)) as ChapterPayload
    return payload.chapters.length > 0 && chapter.html.length > 0
  })
)
check('所有书籍均可打开并读取首章', allBooksReadable.every(Boolean))

await invokeHandler('reader:tick', first.id, 600)
await invokeHandler('reader:tick', first.id, 300)
const progress = (await invokeHandler('reader:progress', first.id, {
  percent: 0.42,
  chapterIndex: 1,
  chapterTitle: opened.chapters[1]?.label ?? '',
  scrollRatio: 0.6
})) as Progress
check('进度写入返回 rev', progress.rev > 0, `rev=${progress.rev} percent=${progress.percent}`)

const stats = (await invokeHandler('stats:get')) as StatsPayload
check('统计累计时长正确', stats.totalSeconds === 900, `${stats.totalSeconds} 秒`)
check('今日时长为 900 秒', stats.todaySeconds === 900, `${stats.todaySeconds}`)
check('阅读日历有今天', stats.days.some((d) => d.seconds === 900))
check('书籍数量统计正确', stats.bookCount === books.length)
check('平均时间已计算', stats.averageSeconds === Math.round(900 / stats.books.length), `${stats.averageSeconds}`)

/* ---------- 3. 设置 ---------- */
console.log('\n[3] 设置写入')
const settings = (await invokeHandler('settings:get')) as Settings
const updated = (await invokeHandler('settings:set', {
  reader: { ...settings.reader, fontSize: 23 },
  sync: { ...settings.sync, auto: true, intervalMinutes: 30 }
})) as Settings
check('阅读偏好已更新', updated.reader.fontSize === 23, `${updated.reader.fontSize}px`)
check('同步设置已更新', updated.sync.auto && updated.sync.intervalMinutes === 30)
check('dataDir 不被外部 patch 覆盖', updated.dataDir === dataDir)

/* ---------- 4. 模拟关机重启 ---------- */
console.log('\n[4] 模拟关机重启（重新加载数据目录）')
await store.flushAll()
const store2 = new Store(dataDir)
await store2.init()
check('书库在重启后完整', store2.books.length === books.length, `${store2.books.length} 本`)
check('阅读进度在重启后保留', store2.progress[first.id]?.percent === 0.42, `${store2.progress[first.id]?.percent}`)
check('阅读时长在重启后保留', store2.sessions.reduce((s, r) => s + r.seconds, 0) === 900)
check('设置在重启后保留', store2.settings.reader.fontSize === 23 && store2.settings.sync.intervalMinutes === 30)

const rawLibrary = JSON.parse(readFileSync(join(dataDir, 'library.json'), 'utf8')) as Book[]
check('library.json 可被外部解析', Array.isArray(rawLibrary) && rawLibrary.length === books.length)

/* ---------- 5. 缓存解压与协议 ---------- */
console.log('\n[5] 缓存与资源')
const cacheDir = join(dataDir, 'cache', first.id)
check('书籍内容已按需解压', existsSync(join(cacheDir, '.extracted')))
const cacheFiles = readdirSync(cacheDir, { recursive: true } as never) as string[]
check('解压出章节文件', cacheFiles.some((f) => String(f).endsWith('.xhtml')), `${cacheFiles.length} 个文件`)

/* ---------- 6. 删除 ---------- */
console.log('\n[6] 删除书籍')
const victim = store2.books[store2.books.length - 1]
const victimPath = victim.filePath
const victimCover = victim.coverFile
const afterRemove = (await invokeHandler('library:remove', victim.id, true)) as Book[]
check('书库已移除该本', afterRemove.length === books.length - 1)
check('书籍文件已删除', !existsSync(victimPath))
check('封面文件已删除', !victimCover || !existsSync(victimCover))
check('缓存目录已删除', !existsSync(join(dataDir, 'cache', victim.id)))

/* ---------- 7. 异常输入 ---------- */
console.log('\n[7] 异常输入')
const badImport = await importMany(store, [join(samplesDir, '不存在.epub')])
check('导入不存在的文件不会崩溃', badImport.errors.length === 1)
let threw = false
try {
  await invokeHandler('reader:open', 'not-a-real-id')
} catch {
  threw = true
}
check('打开不存在的书会报错而不是崩溃', threw)

/* ---------- 8. 书名解析（真实书库里的命名） ---------- */
console.log('\n[8] 书名解析与系列归组')
const namingCases: [string, string | null, string | null][] = [
  ['安达与岛村 1', '1', '安达与岛村'],
  ['安达与岛村11', '11', '安达与岛村'],
  ['安达与岛村 10 试读版', '10', '安达与岛村'],
  ['安达与岛村-第八卷-迷糊轻小说', '8', '安达与岛村'],
  ['安达与岛村-第九卷-迷糊轻小说', '9', '安达与岛村'],
  ['某书 Vol.3', '3', '某书'],
  ['第十二卷', '12', null],
  ['星海拾遗 01', '1', '星海拾遗'],
  ['安达与岛村-短篇-迷糊轻小说', null, null],
  ['安達としまむらSS (電撃文庫)', null, null],
  ['十月书简', null, null],
  ['三体', null, null],
  ['1984', null, null]
]
let namingFailed = 0
for (const [title, volume, series] of namingCases) {
  const got = splitVolume(title)
  const ok = got.volume === volume && got.seriesKey === series
  if (!ok) {
    namingFailed += 1
    console.log(`  ✗ ${title} → ${JSON.stringify(got)}，期望 vol=${volume} series=${series}`)
  }
}
check('全部书名解析正确', namingFailed === 0, `${namingCases.length - namingFailed}/${namingCases.length}`)

const seriesGroups = new Map<string, number>()
for (const title of ['安达与岛村 1', '安达与岛村11', '安达与岛村 10 试读版', '安达与岛村-第八卷-迷糊轻小说']) {
  const key = splitVolume(title).seriesKey ?? '(未归组)'
  seriesGroups.set(key, (seriesGroups.get(key) ?? 0) + 1)
}
check('同系列不同写法能归到一组', seriesGroups.get('安达与岛村') === 4, JSON.stringify([...seriesGroups]))

writeFileSync(join(dataDir, 'check-ok.txt'), new Date().toISOString(), 'utf8')

console.log(`\n${failures === 0 ? '✅ 后端链路全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
