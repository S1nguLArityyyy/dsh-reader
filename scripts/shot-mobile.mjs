/**
 * 手机视口截图（真·390px 布局）。
 *
 * 为什么不能用 `--window-size=390,844`：Windows 上 Chrome/Edge 有**最小窗口宽度**
 * （约 585px），窗口开不到 390 —— 页面仍按 ~585px 布局，媒体查询不生效，
 * 截出来的图只是"左边 390px 的裁切"，会得出完全错误的结论（我们踩过）。
 *
 * 正解：CDP 的 `Emulation.setDeviceMetricsOverride` 覆盖设备指标，布局视口才真的是 390。
 *
 * 用法：
 *   先起预览服务： npm run preview:web
 *   node scripts/shot-mobile.mjs [宽] [高]              # 默认 390 844
 *   SHOTS=library,stats node scripts/shot-mobile.mjs    # 指定要截的页面
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const width = Number(process.argv[2] ?? 390)
const height = Number(process.argv[3] ?? 844)
const base = process.env.SHOT_BASE ?? 'http://127.0.0.1:5199'
const outDir = join(root, 'shots')
const profileDir = join(root, '.edge-profile-mobile')
const shots = (process.env.SHOTS ?? 'library,stats,settings,reader').split(',').filter(Boolean)

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]
const edge = EDGE_CANDIDATES.find((path) => existsSync(path))
if (!edge) {
  console.error('未找到 Microsoft Edge')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
rmSync(profileDir, { recursive: true, force: true })

const port = 9333
const browser = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 等 CDP 端口起来，取一个 page target 的 WebSocket 地址 */
async function findTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('等不到 CDP 端口')
}

/** 极简 CDP 客户端（Node 内置 WebSocket，无需依赖） */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.seq = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const slot = this.pending.get(message.id)
      if (!slot) return
      this.pending.delete(message.id)
      if (message.error) slot.reject(new Error(message.error.message))
      else slot.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((done, fail) => {
      socket.addEventListener('open', () => done())
      socket.addEventListener('error', (err) => fail(err))
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

let failed = 0
try {
  const target = await findTarget()
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)

  // 关键一步：把布局视口真正设成手机尺寸
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true
  })
  // 打开触摸模拟：这样 'ontouchstart' in window 为真，走的是手机分支的文案/手势
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.send('Page.enable')

  for (const item of shots) {
    const [route = 'library', modal = '', extra = ''] = item.split(':')
    const query = [`route=${route}`, modal ? `modal=${modal}` : '', extra].filter(Boolean).join('&')
    await cdp.send('Page.navigate', { url: `${base}/?${query}` })
    await sleep(1800)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const name = `phone-${item.replace(/[:/\\?=&]/g, '-')}.png`
    writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'))
    console.log(`[shot-mobile] ${width}x${height} ${item} -> shots/${name}`)
  }
} catch (err) {
  failed = 1
  console.error('[shot-mobile] 失败：', err instanceof Error ? err.message : err)
} finally {
  browser.kill()
  await sleep(300)
  rmSync(profileDir, { recursive: true, force: true })
}

process.exit(failed)
