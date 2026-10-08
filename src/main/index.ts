import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { enrichBook, importMany } from './library'
import { isInsideDataDir, setDataRoot } from './media'
import { seedDemoStats } from './devseed'
import { Store, resolveDataDir } from './store'
import { startLanServer } from './lan'

app.setName('Dsh Reader')

// 显式指定数据目录时（开发 / 截图 / 多设备演示），把 Electron 自己的 profile 也一起隔离。
// 否则同一台机器上跑多个实例会共用 %APPDATA% 下的同一份 profile（缓存 / Local Storage /
// GPUCache），互相加锁打架；隔离后每个实例的数据与缓存都各自独立。
let lastRecordPush = { at: 0, progress: 0, sessions: 0 }
let lanUrl = ''

const dataDirOverride = process.env.DSH_DATA_DIR
if (dataDirOverride && dataDirOverride.trim()) {
  app.setPath('userData', resolve(dataDirOverride.trim()))
}

/** Windows 下 Electron 是 GUI 子系统进程，控制台日志可能丢失，因此同时写文件 */
const logFile = process.env.DSH_LOG_FILE
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a)))
    .join(' ')}\n`
  if (logFile) {
    try {
      appendFileSync(logFile, line)
    } catch {
      /* 忽略日志写入失败 */
    }
  }
  try {
    process.stdout.write(line)
  } catch {
    /* 无控制台时忽略 */
  }
}

log('[boot] main 模块已加载')

process.on('uncaughtException', (err) => log('uncaughtException', err))
process.on('unhandledRejection', (reason) => log('unhandledRejection', reason))

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

let mainWindow: BrowserWindow | null = null
let store: Store | null = null

const shotDir = process.env.DSH_SHOT_DIR
const shotList = (process.env.DSH_SHOT_LIST ?? 'library').split(',').map((s) => s.trim()).filter(Boolean)

if (shotDir) {
  // 截图 / 无头环境下关闭硬件加速，避免 GPU 初始化失败
  app.disableHardwareAcceleration()
  log('[boot] 已为截图模式关闭硬件加速')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'Dsh Reader',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口失焦时不要降频：切回来第一次动画才不会掉帧
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

async function loadRoute(win: BrowserWindow, route: string, modal: string, extra = ''): Promise<void> {
  const extraQuery: Record<string, string> = {}
  for (const pair of extra.split('&')) {
    if (!pair) continue
    const [key, value = ''] = pair.split('=')
    if (key) extraQuery[key] = value
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(devUrl)
    url.searchParams.set('route', route)
    if (modal) url.searchParams.set('modal', modal)
    for (const [key, value] of Object.entries(extraQuery)) url.searchParams.set(key, value)
    await win.loadURL(url.toString())
    return
  }
  await win.loadFile(join(__dirname, '../renderer/index.html'), {
    query: { route, modal, ...extraQuery }
  })
}

async function runScreenshots(win: BrowserWindow, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const normalWait = Number(process.env.DSH_SHOT_WAIT ?? 1400)
  const firstWait = Number(process.env.DSH_SHOT_DELAY ?? normalWait)
  for (const [index, item] of shotList.entries()) {
    const [route = 'library', modal = '', extra = ''] = item.split(':')
    await loadRoute(win, route, modal, extra)
    await wait(index === 0 ? firstWait : normalWait)
    const image = await win.webContents.capturePage()
    const name = item.replace(/[:/\\]/g, '-')
    await writeFile(join(dir, `${name}.png`), image.toPNG())
    log(`[shot] ${name}`)
  }
  log('[shot] 全部完成')
  app.quit()
}

async function bootstrap(): Promise<void> {
  log('[boot] 启动')
  const dataDir = resolveDataDir()
  await mkdir(dataDir, { recursive: true })
  setDataRoot(dataDir)
  log(`[boot] 数据目录 ${dataDir}`)

  const localStore = new Store(dataDir)
  store = localStore
  await localStore.init()

  // 开发 / 截图用：启动时导入指定 EPUB（分号分隔）
  const importEnv = process.env.DSH_IMPORT
  if (importEnv && importEnv.trim()) {
    const paths = importEnv.split(';').map((s) => s.trim()).filter(Boolean)
    const result = await importMany(localStore, paths)
    log(`[import] 成功 ${result.books.length}，失败 ${result.errors.length}`)
    for (const err of result.errors) log(`[import] ${err}`)
    await localStore.flushAll()
  }

  // 开发 / 截图用：写入示例阅读统计（不会在正式运行时执行）
  if (process.env.DSH_SEED_STATS) seedDemoStats(localStore)

  protocol.handle('dsh', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'media') return new Response('Not Found', { status: 404 })
    const raw = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!isInsideDataDir(raw)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(raw).toString())
  })

  registerIpc(localStore, { url: () => lanUrl, lastPush: () => lastRecordPush })

  // 局域网书籍直传：手机在同一个 WiFi 下可直接高速拉取本机书库（不经网盘、不限速）
  try {
    const lan = await startLanServer({
      booksDir: localStore.booksDir,
      dataDir,
      // 手机推来的记录已写入文件 → 重读进内存并通知界面刷新（否则内存里的旧数据会在下次保存时覆盖回去）
      onRecordsMerged: (info: { progress: number; sessions: number }) => {
        lastRecordPush = { at: Date.now(), progress: info.progress, sessions: info.sessions }
        void localStore.reloadRecords().then(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync:changed')
        })
    // 服务地址写进了 lan.txt，读出来给界面显示
    void readFile(join(app.getPath('userData'), 'lan.txt'), 'utf8')
      .then((text) => {
        const line = String(text)
          .split('\n')
          .map((s) => s.trim())
          .find((s) => s.startsWith('http'))
        if (line) lanUrl = line
      })
      .catch(() => undefined)
      },
      // 手机端据此在下载之前就跳过已有书 ✓ 不必为了比对而下整本 ✓
      hashOf: (fileName: string) => {
        const hit = localStore.books.find((item) => item.fileName === fileName || `${item.id}.epub` === fileName)
        return hit?.contentHash ?? null
      },
      // 手机端直接沿用桌面端算好的主色 ✓（两套实现算"审美"必然不一致 ✗）
      colorOf: (fileName: string) => {
        const hit = localStore.books.find((item) => item.fileName === fileName || `${item.id}.epub` === fileName)
        return hit?.coverColor ?? null
      },
      infoFile: join(app.getPath('userData'), 'lan.txt'),
      log
    })
    log(`[lan] 手机端填这个地址：${lan.urls[0] ?? `http://<电脑IP>:${lan.port}`}`)
  } catch (error) {
    log(`[lan] 启动失败（端口 8787 被占用？）：${String(error)}`)
  }
  mainWindow = createWindow()
  const win = mainWindow

  if (shotDir) {
    win.webContents.once('did-finish-load', () => {
      void runScreenshots(win, shotDir)
    })
  }
  await loadRoute(win, process.env.DSH_ROUTE ?? 'library', process.env.DSH_MODAL ?? '')

  // 界面出来之后再补齐旧书的封面主色 / 字数 / 简介，避免拖慢启动
  win.webContents.once('did-finish-load', () => {
    void backfillLibrary(localStore, win)
  })

}

/** 同步跑完后通知界面刷新：进度、今日阅读显示的是哪本书、统计数字都可能变了 */
function notifySyncChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync:changed')
}

/** 每分钟检查一次是否到了自动同步间隔；改设置不用重建定时器 */

/** 后台补齐旧书信息，每补一本就通知渲染进程刷新 */
async function backfillLibrary(store: Store, win: BrowserWindow): Promise<void> {
  const pending = store.books.filter(
    (book) => !book.coverColor || book.wordCount === 0 || !book.description
  )
  if (pending.length === 0) return
  log(`[backfill] 需要补齐信息的书籍：${pending.length} 本`)

  let changed = 0
  for (const book of pending) {
    if (win.isDestroyed()) return
    const updated = await enrichBook(store, book)
    if (updated) {
      changed += 1
      store.save('library')
      win.webContents.send('library:changed')
    }
  }
  await store.flushAll()
  log(`[backfill] 完成，更新 ${changed} 本`)
}

app.whenReady().then(() => {
  log('[boot] app ready')
  void bootstrap()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      void loadRoute(mainWindow, 'library', '')
    }
  })
})

app.on('child-process-gone', (_event, details) => log('[crash] child-process-gone', JSON.stringify(details)))
app.on('render-process-gone', (_event, _contents, details) =>
  log('[crash] render-process-gone', JSON.stringify(details))
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  // 先等数据落盘再退出，避免最后几秒的进度丢失（或留下 .tmp 半成品）
  if (quitting || !store) return
  event.preventDefault()
  quitting = true

  const localStore = store
  const flushAndQuit = (): void => {
    void localStore
      .flushAll()
      .catch((err) => log('[quit] 落盘失败', err))
      .finally(() => app.quit())
  }

  // 退出前同步一次（已连接云端就做，最多等 3 秒，绝不拖住退出）
  flushAndQuit()
})
