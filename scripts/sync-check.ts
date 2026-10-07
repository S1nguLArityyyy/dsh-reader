/**
 * 同步引擎自检（不依赖 Electron / 真实网盘）：用「本地文件夹」provider 模拟两台设备。
 *
 *   A 导入 → 上传进度
 *   B 导入同一批书（uuid 不同）→ 靠内容指纹对齐并拉取
 *   B 往前读 → A 拉回
 *   两端都改 → 冲突挂起 → 按选择落定
 *   幂等 / 全部下载 / 云端有书本机没有 / 路径穿越
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importMany } from '../src/main/library'
import { Store, todayKey } from '../src/main/store'
import { computeStats } from '../src/main/stats'
import { SyncService } from '../src/main/sync'
import { LocalFolderProvider } from '../src/main/sync/local-folder'
import { CloudPathError, normalizeCloudPath } from '../src/main/sync/provider'
import type { Book, Progress } from '../src/shared/types'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const root = process.cwd()
const workDir = join(root, '.test', 'sync')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

const cloudDir = join(workDir, 'cloud')
const remoteRoot = join(cloudDir, 'DshReader')
const progressDir = join(remoteRoot, 'progress')

const samplesDir = join(root, 'samples')
const sampleFiles = readdirSync(samplesDir)
  .filter((file) => file.toLowerCase().endsWith('.epub'))
  .map((file) => join(samplesDir, file))
if (sampleFiles.length < 2) {
  console.error('samples 目录下至少要有 2 个 EPUB，请先运行 npm run samples')
  process.exit(1)
}

/** 只把失败原因打到台面上：同步引擎平时很安静，出问题时需要看得见 */
const syncLog = (message: string): void => {
  if (message.includes('失败')) console.log(`      ${message}`)
}

/** 可控时钟：冲突判定依赖 updatedAt 与「上次同步时间」的先后 */
let clock = 1_700_000_000_000
const now = (): number => clock
const advance = (ms: number): void => {
  clock += ms
}

/** 每台设备有自己的数据目录与 books 目录（同一台机器模拟多端） */
async function makeDevice(name: string, importSamples: boolean): Promise<{ store: Store; books: Book[] }> {
  const deviceDir = join(workDir, name)
  process.env.DSH_BOOKS_DIR = join(deviceDir, 'books')
  const store = new Store(join(deviceDir, 'data'))
  await store.init()
  // 默认设备名取主机名，同一台机器上模拟多端时区分不开，这里显式命名
  store.settings.deviceName = `设备${name}`
  if (importSamples) {
    const imported = await importMany(store, sampleFiles)
    if (imported.errors.length > 0) console.log(`    导入失败：${imported.errors.join(' / ')}`)
  }
  return { store, books: store.books }
}

function setProgress(store: Store, bookId: string, percent: number, at: number): Progress {
  const record: Progress = {
    bookId,
    percent,
    chapterIndex: 1,
    chapterTitle: '第一章',
    scrollRatio: 0.5,
    updatedAt: at,
    deviceId: store.settings.deviceId,
    rev: (store.progress[bookId]?.rev ?? 0) + 1
  }
  store.progress[bookId] = record
  store.save('progress')
  return record
}

function cloudProgressByKey(): Map<string, any> {
  const map = new Map<string, any>()
  if (!existsSync(progressDir)) return map
  for (const file of readdirSync(progressDir)) {
    if (!file.endsWith('.json')) continue
    const record = JSON.parse(readFileSync(join(progressDir, file), 'utf8'))
    map.set(record.bookKey, record)
  }
  return map
}

/** 引擎用的云端键：sha1:<内容指纹> */
const syncKeyOf = (book?: Book): string => (book?.contentHash ? `sha1:${book.contentHash}` : '')

/* ---------- 1. 设备 A：导入并上传进度 ---------- */
console.log('\n[1] 设备 A：导入 → 选择云端目录 → 上传进度')
const a = await makeDevice('A', true)
check('A 导入了示例书籍', a.books.length === sampleFiles.length, `${a.books.length} 本`)
const syncA = new SyncService(a.store, { chooseDirectory: async () => cloudDir, now, log: syncLog })
check('未选择目录时是未连接状态', !(await syncA.status()).loggedIn)

const a1 = a.books[0]
const a2 = a.books[1]
advance(1000)
setProgress(a.store, a1.id, 0.25, now())
advance(1000)
setProgress(a.store, a2.id, 0.5, now())
advance(1000)

const connectedA = await syncA.connect()
check('连接后进入已连接状态', connectedA.loggedIn && connectedA.account === cloudDir, `${connectedA.account}`)
check(
  '首次同步上传了 2 本进度',
  connectedA.tasks.filter((task) => task.direction === 'up' && task.status === 'done').length === 2,
  connectedA.message ?? ''
)
check('云端生成 2 个进度文件', cloudProgressByKey().size === 2, `${cloudProgressByKey().size} 个`)
check('云端生成 manifest.json', existsSync(join(remoteRoot, 'manifest.json')))
check('云端登记了本机设备', existsSync(join(remoteRoot, 'devices', `${a.store.settings.deviceId}.json`)))
check('设置里记住了同步目录', a.store.settings.sync.localCloudDir === cloudDir)
check('计算了书籍内容指纹', Boolean(a1.contentHash), a1.contentHash?.slice(0, 12) ?? '无')

await a.store.flushAll()
const aProgressRaw = JSON.parse(readFileSync(join(a.store.dataDir, 'progress.json'), 'utf8'))
check('进度已落盘到本地', aProgressRaw[a1.id]?.percent === 0.25)

/* ---------- 2. 设备 B：uuid 不同，靠指纹对齐 ---------- */
console.log('\n[2] 设备 B：导入同一批书（uuid 不同）→ 按内容指纹拉取')
const b = await makeDevice('B', true)
check('B 的书籍 uuid 与 A 不同', b.books[0].id !== a.books[0].id)
const syncB = new SyncService(b.store, { chooseDirectory: async () => cloudDir, now, log: syncLog })
const connectedB = await syncB.connect()
check(
  'B 拉取到 2 本进度',
  connectedB.tasks.filter((task) => task.direction === 'down' && task.status === 'done').length === 2,
  connectedB.message ?? ''
)

const b1 = b.books.find((book) => book.contentHash && book.contentHash === a1.contentHash)
check('两端内容指纹一致（uuid 不同也能对上）', Boolean(b1), `${a1.contentHash?.slice(0, 12)}`)
check('B 的进度数值与 A 相同', Math.abs((b.store.progress[b1?.id ?? '']?.percent ?? -1) - 0.25) < 1e-9, `${b.store.progress[b1?.id ?? '']?.percent}`)
check('拉下来的进度带着来源设备号', b.store.progress[b1?.id ?? '']?.deviceId === a.store.settings.deviceId)

/* ---------- 3. B 往前读 → A 拉回 ---------- */
console.log('\n[3] B 读到 80% → A 同步回来')
advance(60_000)
setProgress(b.store, b1!.id, 0.8, now())
advance(60_000)
const pushedB = await syncB.run()
check('B 上传了自己的新进度', pushedB.tasks.some((task) => task.direction === 'up' && task.status === 'done'), pushedB.message ?? '')
advance(60_000)
await syncA.run()
check('A 拉到了 B 的进度', Math.abs((a.store.progress[a1.id]?.percent ?? -1) - 0.8) < 1e-9, `${a.store.progress[a1.id]?.percent}`)

/* ---------- 4. 两端都改过 → 冲突 ---------- */
console.log('\n[4] 两端都改过同一本书 → 冲突挂起 → 选择保留本地')
advance(60_000)
setProgress(a.store, a1.id, 0.95, now())
advance(60_000)
setProgress(b.store, b1!.id, 0.1, now())
advance(60_000)
await syncB.run() // B 先把自己的 0.1 推上云

advance(60_000)
const conflicted = await syncA.run()
check('检测到冲突并挂起', conflicted.phase === 'conflict', conflicted.message ?? '')
const pending = syncA.pendingConflicts()
check(
  '冲突条目带双方进度与设备',
  pending.length === 1 &&
    pending[0].localPercent === 0.95 &&
    pending[0].cloudPercent === 0.1 &&
    pending[0].localDevice !== pending[0].cloudDevice,
  JSON.stringify(pending[0] ?? {})
)
check('冲突期间云端未被改写', cloudProgressByKey().get(syncKeyOf(a1))?.percent === 0.1)
check('冲突期间不推进上次同步时间', conflicted.lastSyncAt !== clock)

const resolvedA = await syncA.resolve(pending, 'local')
check('选择保留本地后状态完成', resolvedA.phase === 'done' && syncA.pendingConflicts().length === 0, resolvedA.message ?? '')
check('云端被本地覆盖为 0.95', cloudProgressByKey().get(syncKeyOf(a1))?.percent === 0.95)
check(
  '裁决后的云端记录盖上裁决时刻（否则会被别的设备覆盖回来）',
  (cloudProgressByKey().get(syncKeyOf(a1))?.updatedAt ?? 0) > (a.store.progress[a1.id]?.updatedAt ?? 0)
)

advance(60_000)
await syncB.run()
check('B 随后拿到 A 的选择', Math.abs((b.store.progress[b1!.id]?.percent ?? -1) - 0.95) < 1e-9, `${b.store.progress[b1!.id]?.percent}`)

/* ---------- 5. 幂等 / 全部下载 ---------- */
console.log('\n[5] 幂等与「全部下载」')
const idle = await syncA.run()
check('两端一致时不再产生任务', idle.tasks.filter((task) => task.status !== 'skipped').length === 0, `${idle.tasks.length} 项任务`)

advance(60_000)
setProgress(b.store, b1!.id, 0.33, now())
advance(60_000)
await syncB.run()
const beforePull = a.store.progress[a1.id]?.percent
const pulled = await syncA.downloadAll()
check(
  '「全部下载」一律以云端为准',
  Math.abs((a.store.progress[a1.id]?.percent ?? -1) - 0.33) < 1e-9,
  `${beforePull} → ${a.store.progress[a1.id]?.percent}`
)
check('「全部下载」不产生冲突挂起', pulled.phase === 'done' && syncA.pendingConflicts().length === 0, pulled.message ?? '')

/* ---------- 6. 云端有书、本机没有 ---------- */
console.log('\n[6] 云端有的书本机没有 → 如实跳过')
const c = await makeDevice('C', false)
check('C 是空书库', c.store.books.length === 0)
const syncC = new SyncService(c.store, { chooseDirectory: async () => cloudDir, now, log: syncLog })
const stateC = await syncC.connect()
const skipped = stateC.tasks.filter((task) => task.status === 'skipped').length
check('按跳过处理而不是凭空造书', skipped >= 2 && c.store.books.length === 0, `跳过 ${skipped} 项`)
check('提示里说明了跳过原因', /跳过/.test(stateC.message ?? ''), stateC.message ?? '')

/* ---------- 7. 云端清单 ---------- */
console.log('\n[7] 云端清单与目录结构')
const manifest = JSON.parse(readFileSync(join(remoteRoot, 'manifest.json'), 'utf8'))
const entries = Object.values(manifest.progress ?? {}) as Array<{ title?: string; percent?: number }>
check('清单里带书名与进度', entries.length >= 2 && entries.every((entry) => typeof entry.title === 'string'), `${entries.length} 条`)
check('清单带 schema 版本', manifest.schema === 2)
check('设备登记包含设备名', Boolean(JSON.parse(readFileSync(join(remoteRoot, 'devices', `${a.store.settings.deviceId}.json`), 'utf8')).deviceName))
check('同步时间已落盘', typeof JSON.parse(readFileSync(join(a.store.dataDir, 'sync', 'state.json'), 'utf8')).lastSyncAt === 'number')
check('原子写没有留下临时文件', readdirSync(progressDir).filter((file) => file.endsWith('.tmp')).length === 0)

/* ---------- 8. provider 边界 ---------- */
console.log('\n[8] provider 边界与路径安全')
const provider = new LocalFolderProvider({ getRoot: () => cloudDir, chooseRoot: async () => null })
let traversal = false
try {
  await provider.read('/../逃逸.json')
} catch (err) {
  traversal = err instanceof CloudPathError
}
check('拒绝 .. 路径穿越', traversal)

let driveRejected = false
try {
  normalizeCloudPath('C:/Windows/System32')
} catch {
  driveRejected = true
}
check('拒绝盘符路径', driveRejected)

check('读不存在的文件返回 null', (await provider.read('/DshReader/不存在.json')) === null)
check('未选择目录时 account() 为 null', (await new LocalFolderProvider({ getRoot: () => null, chooseRoot: async () => null }).account()) === null)
check('云端同步文件夹不存在时自动创建', existsSync(join(remoteRoot, 'progress')))

/* ---------- 9. 阅读时长同步 ---------- */
console.log('\n[9] 阅读时长同步（主界面「今日阅读」的数字与书名来源）')
const day = todayKey()
const b2 = b.books.find((book) => book.contentHash && book.contentHash === a2.contentHash)
check('B 也有第 2 本书（同一份文件、不同 uuid）', Boolean(b2), b2?.id.slice(0, 8) ?? '无')

advance(60_000)
a.store.addReadingTime(a1.id, 900) // 设备A 读第 1 本
// addReadingTime 用的是真实时钟，这里把时间戳改成可控值，保证先后关系确定
const aRow = a.store.sessions.find((row) => row.day === day && row.bookId === a1.id)
if (aRow) {
  aRow.firstAt = now() - 300_000
  aRow.lastAt = now()
}
advance(60_000)
b.store.addReadingTime(b2!.id, 300) // 设备B 读第 2 本（时间更晚）
const bRow = b.store.sessions.find((row) => row.day === day && row.bookId === b2!.id)
if (bRow) {
  bRow.firstAt = now() - 60_000
  bRow.lastAt = now()
}

const statsRun = await syncA.run()
check(
  'A 上传了阅读时长',
  statsRun.tasks.some((task) => task.kind === 'stats' && task.direction === 'up' && task.status === 'done'),
  statsRun.message ?? ''
)
await syncB.run()
await syncA.run()

const secondsOf = (store: Store): number =>
  store.sessions.filter((row) => row.day === day).reduce((sum, row) => sum + row.seconds, 0)
const todayRows = (store: Store): number => store.sessions.filter((row) => row.day === day).length

check(
  '两端的当日时长相加，而不是互相覆盖',
  secondsOf(a.store) === 1200 && secondsOf(b.store) === 1200,
  `A=${secondsOf(a.store)} B=${secondsOf(b.store)}`
)
check('按设备各存一条', todayRows(a.store) === 2 && todayRows(b.store) === 2, `A=${todayRows(a.store)} 条 B=${todayRows(b.store)} 条`)
check(
  '统计聚合把别的设备的时长算进去',
  computeStats(a.store).todaySeconds === 1200,
  `${computeStats(a.store).todaySeconds} 秒`
)
check(
  '「今日阅读」显示的书也同步过去了（A 的卡片变成 B 刚读的那本）',
  computeStats(a.store).todayBookId === a2.id && computeStats(b.store).todayBookId === b2!.id,
  `A→${computeStats(a.store).todayBookId?.slice(0, 8)} B→${computeStats(b.store).todayBookId?.slice(0, 8)}`
)
check('云端出现 sessions 目录', existsSync(join(remoteRoot, 'sessions')))

await syncA.run()
await syncB.run()
await syncA.run()
check(
  '重复同步不会把时长翻倍',
  secondsOf(a.store) === 1200 && secondsOf(b.store) === 1200,
  `A=${secondsOf(a.store)} B=${secondsOf(b.store)}`
)

/* ---------- 10. 退出阅读触发的后台同步 ---------- */
console.log('\n[10] 退出阅读 / 后台自动同步')
// 关掉开关：合上书不应该触发同步（门槛在 afterReading 上）
a.store.settings.sync.onReaderClose = false
advance(60_000)
setProgress(a.store, a1.id, 0.61, now())
syncA.afterReading()
await new Promise((resolve) => setTimeout(resolve, 1800))
check(
  '设置里关掉后，合上书不会触发同步',
  cloudProgressByKey().get(syncKeyOf(a1))?.percent !== 0.61,
  `云端仍是 ${cloudProgressByKey().get(syncKeyOf(a1))?.percent}`
)
a.store.settings.sync.onReaderClose = true

advance(60_000)
setProgress(a.store, a1.id, 0.66, now())
const background = await syncA.runInBackground()
check(
  '后台同步把新进度推上云端',
  background !== null &&
    background.tasks.some((task) => task.kind === 'progress' && task.direction === 'up' && task.status === 'done'),
  background?.message ?? '未执行'
)
check('云端进度确实更新了', cloudProgressByKey().get(syncKeyOf(a1))?.percent === 0.66)

const throttled = await syncA.runInBackground()
check('短时间内重复触发被节流（不会每个动作都去打网盘）', throttled === null)

// afterReading 是延迟触发：先返回，等 1.2 秒才真正同步（等渲染进程把最后一条进度发过来）
advance(60_000)
setProgress(a.store, a1.id, 0.7, now())
syncA.afterReading()
await new Promise((resolve) => setTimeout(resolve, 1800))
check(
  '退出阅读后的延迟同步确实跑了',
  cloudProgressByKey().get(syncKeyOf(a1))?.percent === 0.7,
  `${cloudProgressByKey().get(syncKeyOf(a1))?.percent}`
)

check('已配置云端时 isConfigured() 为真（自动同步靠它判断）', syncA.isConfigured())

/* ---------- 11. 书籍文件同步 ---------- */
console.log('\n[11] 书籍文件同步（上传 / 校验 / 下载入册 / 上限）')
const cloudBooksDir = join(remoteRoot, 'books')
const bookFileOf = (book: Book): string =>
  join(cloudBooksDir, `${encodeURIComponent(`sha1:${book.contentHash}`)}.epub`)

a.store.settings.sync.uploadBooks = true
const shared = a.books[0]
shared.syncUpload = true
advance(60_000)
const uploadedBook = await syncA.run()
check(
  '上传书籍本体',
  uploadedBook.tasks.some((task) => task.kind === 'book' && task.direction === 'up' && task.status === 'done'),
  uploadedBook.message ?? ''
)
check('云端出现书籍文件（键 = 内容指纹）', existsSync(bookFileOf(shared)), bookFileOf(shared).replace(remoteRoot, ''))

const reupload = await syncA.run()
check(
  '云端已有同一份时不重传',
  !reupload.tasks.some((task) => task.kind === 'book' && task.direction === 'up' && task.status === 'done'),
  reupload.message ?? ''
)

const listedOnly = await syncC.run()
check(
  '本机没有的书只提示、不偷偷下载',
  c.store.books.length === 0 && /可下载/.test(listedOnly.message ?? ''),
  listedOnly.message ?? ''
)

const downloadedBooks = await syncC.downloadAll()
check('「全部下载云端书籍」把书拉下来', c.store.books.length === 1, `${c.store.books.length} 本`)
const arrived = c.store.books[0]
check('入册后的指纹与云端键一致', arrived?.contentHash === shared.contentHash, `${arrived?.contentHash?.slice(0, 12)}`)
check('落盘到本机 books 目录', Boolean(arrived && existsSync(arrived.filePath)))
check('书能读（章节解析出来了）', (arrived?.chapterCount ?? 0) > 0, `${arrived?.chapterCount} 章`)
check('提示里报告了下载书籍', /下载书籍/.test(downloadedBooks.message ?? ''), downloadedBooks.message ?? '')

// 内容被改坏 → sha1 校验兜住，拒绝入册
const secondBook = a.books[1]
secondBook.syncUpload = true
advance(60_000)
await syncA.run()
const secondFile = bookFileOf(secondBook)
check('第二本书也传上去了', existsSync(secondFile))
writeFileSync(secondFile, Buffer.from('这不是一个 EPUB 文件'), 'utf8')
const beforeCorrupt = c.store.books.length
advance(60_000)
const corruptRun = await syncC.downloadAll()
check(
  '云端文件被改坏后拒绝入册（sha1 校验兜住）',
  c.store.books.length === beforeCorrupt,
  `仍是 ${c.store.books.length} 本`
)
check('并且如实报告失败', corruptRun.tasks.some((task) => task.kind === 'book' && task.status === 'error'))

// 大小上限：换一台空设备，把上限调成 1KB
const fourth = await makeDevice('D', false)
const syncD = new SyncService(fourth.store, { chooseDirectory: async () => cloudDir, now, maxBookBytes: 1024, log: syncLog })
await syncD.connect()
const limited = await syncD.downloadAll()
check('超过单本上限的书不下载', fourth.store.books.length === 0, `${fourth.store.books.length} 本`)
check(
  '上限跳过会体现在任务里',
  limited.tasks.some((task) => task.kind === 'book' && task.status === 'skipped'),
  limited.message ?? ''
)

writeFileSync(join(workDir, 'check-ok.txt'), new Date().toISOString(), 'utf8')

console.log(`\n${failures === 0 ? '✅ 同步链路全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
