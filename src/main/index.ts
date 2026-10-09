import { app, BrowserWindow, Menu, net, protocol, shell, Tray, nativeImage } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ipcMain } from 'electron'
import { registerIpc } from './ipc'
import { enrichBook, importMany } from './library'
import { isInsideDataDir, setDataRoot } from './media'
import { seedDemoBookmarks, seedDemoStats } from './devseed'
import { Store, resolveDataDir } from './store'
import { lanTransfer, startLanServer } from './lan'

app.setName('Dsh Reader')

// 单实例：程序已经开着时再点一次 exe，只把已有窗口显示出来，不再开第二个实例
// （之前会出现两个实例、8 个进程，内存翻倍）
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    log('[startup] 检测到第二次启动，显示已有窗口')
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      showMainWindow()
    }
  })
}

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
/** 崩溃兜底日志：直接同步写文件，任何异常都不再吞掉 */
function crashLog(label: string, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `[${new Date().toISOString()}] ${label} ${text}\n`
  try {
    process.stderr.write(line)
  } catch {
    /* 忽略 */
  }
  if (!logFile) return
  try {
    writeFileSync(`${logFile}.crash`, line, { flag: 'a' })
  } catch {
    try {
      writeFileSync(join(tmpdir(), 'dsh-crash.log'), line, { flag: 'a' })
    } catch {
      /* 忽略 */
    }
  }
}

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

let tray: Tray | null = null
let quitFromTray = false
/** 开机自启的首次启动不显示窗口，之后托盘重建的窗口照常显示 */
let startupHidden = process.argv.includes('--hidden')

let hiddenTimer: NodeJS.Timeout | null = null

/** 隐藏几分钟后释放窗口：后台只保留局域网服务，降低内存占用 */
function scheduleIdleRelease(): void {
  if (hiddenTimer) clearTimeout(hiddenTimer)
  log('[tray] 已隐藏：渲染暂停，窗口保留（局域网服务继续运行）')
}

/** 托盘点击时确保有窗口可用 */
function showMainWindow(): void {
  if (hiddenTimer) {
    clearTimeout(hiddenTimer)
    hiddenTimer = null
  }
  if (!mainWindow) {
    mainWindow = createWindow()
    return
  }
  mainWindow.show()
  mainWindow.focus()
}

/** 托盘图标：打包后用 exe 自带的图标，开发时退回 Electron 的图标 */
function createTrayIcon(): Electron.NativeImage {
  const realExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  const exeIcon = nativeImage.createFromPath(realExe)
  if (!exeIcon.isEmpty()) return exeIcon
  return nativeImage.createEmpty()
}

/** 托盘：左键切换主窗口，右键菜单可显示或退出 */
/**
 * 托盘图标：必须用 app.getFileIcon 从 exe 里提取。
 * nativeImage.createFromPath 只认 PNG/JPEG，传 exe 进去得到的是空图标，所以之前托盘看不见。
 */
async function applyTrayIcon(): Promise<void> {
  const realExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  try {
    // 优先用打进包里的 PNG：exe 自身没有嵌入应用图标，getFileIcon 只能拿到通用占位图
    const fromPng = nativeImage.createFromPath(join(process.resourcesPath, 'icon.png'))
    if (!fromPng.isEmpty()) {
      tray?.setImage(fromPng.resize({ width: 16, height: 16 }))
      log('[tray] 图标已设置（包内 PNG）')
      return
    }
    log('[tray] 包内 PNG 不可用，退回 exe 图标')
    const icon = await app.getFileIcon(realExe, { size: 'small' })
    if (!icon.isEmpty()) {
      tray?.setImage(icon)
      log('[tray] 图标已设置')
    } else {
      log('[tray] getFileIcon 返回空图标')
    }
  } catch (error) {
    log('[tray] 提取图标失败', String(error))
  }
}

function setupTray(win: BrowserWindow): void {
  if (tray) return
  try {
    // 创建托盘时就带上真图标：Windows 上用空图标建的托盘不会显示，事后补不回来
    // 图标来自打包进 resources 的 icon.png（见 electron-builder.yml 的 extraResources）
    const trayIconPath = join(process.resourcesPath, 'icon.png')
    const trayIcon = nativeImage.createFromPath(trayIconPath)
    tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon.resize({ width: 16, height: 16 }))
    log('[tray] 图标来源 ' + trayIconPath + ' 可用=' + !trayIcon.isEmpty())
    tray.setToolTip('Dsh Reader 正在运行（手机可通过局域网同步）')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示主窗口',
          click: () => {
            showMainWindow()
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitFromTray = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', () => {
      if (!mainWindow) return
      if (mainWindow.isVisible()) mainWindow.hide()
      else {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (error) {
    log('[tray] 创建托盘失败', String(error))
  }
  void win
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
      // 保留默认的后台节流：窗口隐藏时停止渲染与定时器，可见时不受影响
    }
  })

  win.on('ready-to-show', () => {
    // 开机自启带 --hidden 时静默进托盘
    if (startupHidden) {
      log('[startup] --hidden：只驻留托盘')
      startupHidden = false
    } else {
      win.show()
    }
  })
  // 关闭按钮不退出：桌面端是局域网服务端，退出会让手机立刻断连
  win.on('close', (event) => {
    if (quitFromTray) return
    event.preventDefault()
    win.hide()
    log('[tray] 已隐藏到托盘，局域网服务继续运行')
    scheduleIdleRelease()
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

/** 便携版运行时程序被解压到临时目录，process.execPath 是那个临时路径，
 *  拿它写登录项会立刻失效 —— 真实路径在 PORTABLE_EXECUTABLE_FILE 里 */
function loginItemPath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

/** 托盘与开机自启的 IPC（直接注册，不经过 ipc.ts 的 store 桥）。只能调一次。 */
function registerAppHandlers(): void {
  ipcMain.handle('app:hideToTray', () => {
    mainWindow?.hide()
    return true
  })

  ipcMain.handle('app:getAutoLaunch', () => {
    const path = loginItemPath()
    try {
      // Windows 上必须把 args 一起比对：我们的记录带 --hidden，不传 args 就永远匹配不上
      const withHidden = app.getLoginItemSettings({ path, args: ['--hidden'] }).openAtLogin
      const plain = app.getLoginItemSettings({ path, args: [] }).openAtLogin
      const fromExe = withHidden || plain
      // 早期版本可能把临时路径写进去了，这里一并检查默认查询结果
      return fromExe || app.getLoginItemSettings().openAtLogin
    } catch (error) {
      log('[autolaunch] 读取失败', String(error))
      return false
    }
  })

  ipcMain.handle('app:setAutoLaunch', (_event, enabled: boolean, hideOnStart: boolean) => {
    const path = loginItemPath()
    log(`[autolaunch] 设置 openAtLogin=${enabled === true} hideOnStart=${hideOnStart === true} path=${path}`)
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled === true,
        path,
        args: hideOnStart === true ? ['--hidden'] : []
      })
      const now = app.getLoginItemSettings({ path, args: hideOnStart === true ? ['--hidden'] : [] }).openAtLogin
      log(`[autolaunch] 设置后系统回报 openAtLogin=${now}`)
      return now
    } catch (error) {
      log('[autolaunch] 设置失败', String(error))
      return false
    }
  })
}

async function bootstrap(): Promise<void> {
  log('[boot] 启动')
  const dataDir = resolveDataDir()
  try {
    await mkdir(dataDir, { recursive: true })
  } catch (error) {
    // 数据目录建不出来（无权限 / 路径不可写）时说清楚，否则界面永远不出现、也没有任何线索
    log(`[boot] 数据目录创建失败：${dataDir}`, String(error))
    throw error
  }
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

  // 开发 / 截图用：写入示例书签（摘录取真正文）
  if (process.env.DSH_SEED_BOOKMARKS) await seedDemoBookmarks(localStore)

  protocol.handle('dsh', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'media') return new Response('Not Found', { status: 404 })
    const raw = decodeURIComponent(url.pathname.replace(/^\//, ''))
    if (!isInsideDataDir(raw)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(raw).toString())
  })

  // 主窗口的托盘 / 开机自启 IPC：整个进程只注册一次
  registerAppHandlers()

  // 局域网书籍直传：手机在同一个 WiFi 下可直接高速拉取本机书库（不经网盘、不限速）
  try {
    const lan = await startLanServer({
      booksDir: localStore.booksDir,
      dataDir,
      // 手机推来的记录已写入文件 → 重读进内存并通知界面刷新（否则内存里的旧数据会在下次保存时覆盖回去）
      onRecordsMerged: (info: { progress: number; sessions: number; finished: Record<string, string> }) => {
        lastRecordPush = { at: Date.now(), progress: info.progress, sessions: info.sessions }
        // 「已读完」的并集由 lan.ts 落盘，这里并回 store 的内存状态
        localStore.finished = { ...localStore.finished, ...info.finished }
        localStore.save('finished')
        void localStore.reloadRecords().then(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lan:changed')
        })
      },
      // 手机推来的记录与电脑端冲突 → 整批暂缓，弹窗请用户裁决
      onConflictPending: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lan:conflict')
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

    registerIpc(localStore, {
      url: () => lanUrl,
      lastPush: () => lastRecordPush,
      transfer: () => lanTransfer(),
      pendingConflicts: () => lan.pendingConflicts(),
      resolveConflicts: (choices) => lan.resolveConflicts(choices)
    })
    // 启动时若还有上次没裁决完的冲突，等界面就绪后提醒
    const outstanding = lan.pendingConflicts()
    if (outstanding.length > 0) {
      log(`[lan] 有 ${outstanding.length} 处冲突等待裁决`)
      mainWindow?.webContents.once('did-finish-load', () => {
        mainWindow?.webContents.send('lan:conflict')
      })
    }
  } catch (error) {
    log(`[lan] 启动失败（端口 8787 被占用？）：${String(error)}`)
    registerIpc(localStore, { url: () => lanUrl, lastPush: () => lastRecordPush, transfer: () => lanTransfer() })
  }
  mainWindow = createWindow()
  const win = mainWindow
  setupTray(win)

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
  void bootstrap().catch((error) => {
    log('[boot] bootstrap 失败', error)
    crashLog('[boot] bootstrap 失败', error)
  })
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
  // 有托盘就继续在后台提供局域网服务，只有托盘菜单的「退出」才真的退出
  if (tray) {
    log('[tray] 窗口已全部关闭，应用继续驻留托盘')
    return
  }
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
