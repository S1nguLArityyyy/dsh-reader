/**
 * 用 Edge 无头模式对浏览器预览页面逐页截图（不依赖 Electron）。
 * 使用前先启动预览服务：npm run preview:web
 * 用法：node scripts/shot-web.mjs [baseUrl]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shotDir = join(root, 'shots')
const profileDir = join(root, '.edge-profile')
const base = process.argv[2] ?? 'http://127.0.0.1:5199'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]
const edge = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!edge) {
  console.error('未找到 Microsoft Edge')
  process.exit(1)
}

const SHOTS = (
  process.env.SHOTS ??
  'library,stats,settings,reader,library:sync,settings:conflict,stats::cal=heatmap,library::preview=nobooks,stats::preview=dark,reader::preview=paged'
).split(',')

mkdirSync(shotDir, { recursive: true })
rmSync(profileDir, { recursive: true, force: true })

let failed = 0
for (const item of SHOTS) {
  const [route = 'library', modal = '', extra = ''] = item.split(':')
  const query = [`route=${route}`, modal ? `modal=${modal}` : '', extra].filter(Boolean).join('&')
  const url = `${base}/?${query}`
  const file = join(shotDir, `${item.replace(/[:/\\?=&]/g, '-')}.png`)
  rmSync(file, { force: true })
  const result = spawnSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1280,800',
      '--virtual-time-budget=4000',
      `--user-data-dir=${profileDir}`,
      `--screenshot=${file}`,
      url
    ],
    { stdio: 'ignore', timeout: 90000 }
  )
  const ok = existsSync(file)
  if (!ok) failed += 1
  console.log(`[shot-web] ${item.padEnd(20)} -> ${ok ? file : '失败'} (code ${result.status})`)
}
rmSync(profileDir, { recursive: true, force: true })
process.exit(failed > 0 ? 1 : 0)
