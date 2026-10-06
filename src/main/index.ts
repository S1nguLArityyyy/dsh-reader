import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { enrichBook, importMany } from './library'
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

  registerIpc(localStore, new SyncService())

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
  void store
    .flushAll()
    .catch((err) => log('[quit] 落盘失败', err))
    .finally(() => app.quit())
})
