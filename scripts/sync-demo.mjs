/**
 * 同步功能验收台：在同一台机器上模拟两台设备，共用一个「云端」文件夹。
 *
 * 用法：
 *   npm run build && npm run sync:demo              # 默认根目录 D:\DshReaderSync
 *   node scripts/sync-demo.mjs D:\MySyncDemo        # 指定根目录
 *
 * 会准备好：
 *   <根目录>\cloud\                  共用的「云端」目录（两台设备都指向它）
 *   <根目录>\device-A\{data,books}   设备 A 的数据目录与书籍目录
 *   <根目录>\device-B\{data,books}   设备 B 的数据目录与书籍目录
 *
 * 首次运行会给两台设备各导入 samples 里的示例书。注意：两台设备各自导入同一份文件，
 * 生成的 Book.id（uuid）是不同的 —— 同步靠内容指纹对齐，这正是要验证的点。
 * 再次运行不会重复导入（只看是否存在 library.json）。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 默认放在项目里的 .test 下（已忽略）：从 DSH 会话的终端启动时，子进程只能写工作区内的路径
const demoRoot = resolve(process.argv[2] ?? join(root, '.test', 'sync-demo'))
const cloudDir = join(demoRoot, 'cloud')

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('还没有构建产物，请先运行：npm run build')
  process.exit(1)
}

const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electronExe)) {
  console.error('未找到 Electron，请先运行：npm install')
  process.exit(1)
}

const samplesDir = join(root, 'samples')
const samples = existsSync(samplesDir)
  ? readdirSync(samplesDir)
      .filter((file) => file.toLowerCase().endsWith('.epub'))
      .map((file) => join(samplesDir, file))
  : []

mkdirSync(cloudDir, { recursive: true })
console.log(`[demo] 云端目录：${cloudDir}`)

const devices = []
for (const label of ['A', 'B']) {
  const base = join(demoRoot, `device-${label}`)
  const dataDir = join(base, 'data')
  const booksDir = join(base, 'books')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(booksDir, { recursive: true })

  // 预置设置：设备名 + 云端目录 + 自动同步，省得每次手点
  const settingsPath = join(dataDir, 'settings.json')
  let saved = {}
  try {
    saved = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    /* 首次运行 */
  }
  const settings = {
    ...saved,
    deviceId: saved.deviceId ?? randomUUID(),
    deviceName: `设备${label}`,
    sync: {
      ...(saved.sync ?? {}),
      provider: 'local',
      localCloudDir: cloudDir,
      auto: true,
      intervalMinutes: 5,
      remoteDir: '/DshReader'
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')

  devices.push({ label, dataDir, booksDir, firstRun: !existsSync(join(dataDir, 'library.json')) })
}

for (const device of devices) {
  const env = { ...process.env, DSH_DATA_DIR: device.dataDir, DSH_BOOKS_DIR: device.booksDir }
  // 从 DSH 会话的终端启动时，这个变量会让 electron.exe 退化成纯 Node，必须去掉
  delete env.ELECTRON_RUN_AS_NODE
  if (device.firstRun && samples.length > 0) env.DSH_IMPORT = samples.join(';')

  // 走项目自带的启动器（scripts/dev.mjs）：它会带上本机必需的 --noSandbox，
  // 并处理「Electron 运行时在非 ASCII 路径」的情况。直接 spawn electron.exe 会因为
  // 缺这个开关而在 app ready 之前就崩掉（本机实测：0x80000003）。
  const child = spawn(process.execPath, [join(root, 'scripts', 'dev.mjs'), 'preview', '--skipBuild'], {
    cwd: root,
    env,
    stdio: 'ignore',
    detached: true
  })
  child.unref()
  console.log(`[demo] 已启动「设备${device.label}」 PID=${child.pid}（数据目录 ${device.dataDir}）`)
}

console.log(`
─────────────── 怎么测 ───────────────
两个窗口分别是「设备A」和「设备B」，都已连上同一个云端目录；首次运行各导入了示例书。

1) 上传：在【设备A】打开一本书翻几页 → 点「立即同步」→ 应显示「同步完成：上传 1 本」。
   想眼见为实，打开这个目录看进度文件：
   ${join(cloudDir, 'DshReader', 'progress')}

2) 另一端拉取：切到【设备B】，打开同一本书 → 点「立即同步」→ 应显示「下载 1 本」，
   进度与 A 一致（两边的书籍 uuid 不同，靠内容指纹对上——这是关键点）。

3) 冲突：两端各同步一次（建立时间基线）之后，
   A 翻几页但先别同步 → 在 A 点同步；再 B 翻几页 → 在 B 点同步
   → B 弹出「发现阅读进度冲突」，选「保留本地」或「使用云端」并确认
   → 回到 A 点同步，A 会拿到 B 刚做的选择（裁决不会被覆盖回来）。

4) 自动同步：两端都已打开（间隔 5 分钟，退出前也会同步一次），不点按钮也会自己同步；
   想看得更清楚，可以先在设置里把「自动同步」关掉。

数据都在 ${demoRoot} 下，删掉这个目录就等于全部重置。
`)
