import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { importMany } from './library'
import { isInsideDataDir, setDataRoot } from './media'
import { seedDemoStats } from './devseed'
import { Store, resolveDataDir } from './store'
import { SyncService } from './sync'

app.setName('Dsh Reader')

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
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'Dsh Reader',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
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

async function loadRoute(win: BrowserWindow, route: string, modal: string): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(devUrl)
    url.searchParams.set('route', route)
    if (modal) url.searchParams.set('modal', modal)
    await win.loadURL(url.toString())
    return
  }
  await win.loadFile(join(__dirname, '../renderer/index.html'), { query: { route, modal } })
}

async function runScreenshots(win: BrowserWindow, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const item of shotList) {
    const [route = 'library', modal = ''] = item.split(':')
    await loadRoute(win, route, modal)
    await wait(1400)
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

  store = new Store(dataDir)
  await store.init()

  // 开发 / 截图用：启动时导入指定 EPUB（分号分隔）
  const importEnv = process.env.DSH_IMPORT
  if (importEnv && importEnv.trim()) {
    const paths = importEnv.split(';').map((s) => s.trim()).filter(Boolean)
    const result = await importMany(store, paths)
    log(`[import] 成功 ${result.books.length}，失败 ${result.errors.length}`)
    for (const err of result.errors) log(`[import] ${err}`)
    await store.flushAll()
  }

  // 开发 / 截图用：写入示例阅读统计（不会在正式运行时执行）
  if (process.env.DSH_SEED_STATS) seedDemoStats(store)

  protocol.handle('dsh', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'media') return new Response('Not Found', { status: 404 })
    const raw = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!isInsideDataDir(raw)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(raw).toString())
  })

  registerIpc(store, new SyncService())

  mainWindow = createWindow()
  const win = mainWindow

  if (shotDir) {
    win.webContents.once('did-finish-load', () => {
      void runScreenshots(win, shotDir)
    })
  }
  await loadRoute(win, process.env.DSH_ROUTE ?? 'library', process.env.DSH_MODAL ?? '')
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

app.on('before-quit', () => {
  if (store) void store.flushAll()
})
