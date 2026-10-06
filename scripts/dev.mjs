/**
 * 启动器：绕过「Electron 可执行文件位于非 ASCII 路径时无法启动」的问题。
 *
 * 背景：若 node_modules/electron/dist 的绝对路径含中文（例如项目在“桌面”下），
 * Electron 的浏览器进程会在 app ready 之前直接崩溃（0xC0000005），
 * 且与是否加 --no-sandbox、Electron 版本无关。
 *
 * 做法：把 Electron 运行时复制到纯 ASCII 路径（默认 %LOCALAPPDATA%\DshReader\runtime），
 * 再通过 ELECTRON_EXEC_PATH / ELECTRON_OVERRIDE_DIST_PATH 让启动器使用它。
 * 注意：目录联接（junction）不行，加载器仍会解析到真实的中文路径，必须用真实副本。
 *
 * 若把整个项目放到纯 ASCII 路径（例如 D:\DshReader），本脚本会自动跳过复制。
 *
 * 用法：
 *   node scripts/dev.mjs dev       # 开发模式（等价 npm run dev）
 *   node scripts/dev.mjs preview   # 运行打包产物
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distPath = join(root, 'node_modules', 'electron', 'dist')
const electronPkg = join(root, 'node_modules', 'electron', 'package.json')

if (!existsSync(electronPkg) || !existsSync(distPath)) {
  console.error('未找到 Electron，请先运行 npm install')
  process.exit(1)
}

const version = JSON.parse(readFileSync(electronPkg, 'utf8')).version
const isAscii = (value) => /^[\x20-\x7e]*$/.test(value)

const mode = process.argv[2] === 'preview' ? 'preview' : 'dev'
const passthrough = process.argv.slice(3)
const env = { ...process.env }

if (!isAscii(distPath)) {
  const runtimeRoot =
    process.env.DSH_ELECTRON_RUNTIME ??
    join(process.env.LOCALAPPDATA ?? 'C:\\DshReaderRuntime', 'DshReader', 'runtime')
  const target = join(runtimeRoot, `electron-${version}`)

  if (!existsSync(join(target, 'electron.exe'))) {
    mkdirSync(runtimeRoot, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    console.log(`[launch] 正在把 Electron 运行时复制到 ASCII 路径：${target}`)
    cpSync(distPath, target, { recursive: true })
    console.log('[launch] 复制完成')
  }

  env.ELECTRON_OVERRIDE_DIST_PATH = target
  // electron-vite 直接读 ELECTRON_EXEC_PATH，两者都设上最稳
  env.ELECTRON_EXEC_PATH = join(target, 'electron.exe')
  console.log(`[launch] Electron 位于非 ASCII 路径，已改用：${target}`)
}

const cli = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
if (!existsSync(cli)) {
  console.error('未找到 electron-vite，请先运行 npm install')
  process.exit(1)
}

const child = spawn(process.execPath, [cli, mode, '--noSandbox', ...passthrough], {
  cwd: root,
  env,
  stdio: 'inherit'
})
child.on('exit', (code) => process.exit(code ?? 0))
