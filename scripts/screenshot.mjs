/**
 * 截图验收脚本：用独立的开发数据目录启动应用，逐页截图到 shots/。
 * 用法：npm run shot           （默认 6 张）
 *      SHOTS=library,stats npm run shot
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(root, '.devdata')
const shotDir = join(root, 'shots')
const samplesDir = join(root, 'samples')

const samples = existsSync(samplesDir)
  ? readdirSync(samplesDir)
      .filter((name) => name.toLowerCase().endsWith('.epub'))
      .map((name) => join(samplesDir, name))
  : []

// 每次截图都用干净的数据目录，避免重复导入
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(shotDir, { recursive: true })

const env = {
  ...process.env,
  DSH_DATA_DIR: dataDir,
  DSH_SHOT_DIR: shotDir,
  DSH_LOG_FILE: join(root, 'shots', 'main.log'),
  DSH_SHOT_LIST: process.env.SHOTS ?? 'library,stats,settings,library:sync,settings:conflict,reader',
  DSH_SEED_STATS: '1'
}
delete env.ELECTRON_RUN_AS_NODE
if (samples.length > 0) env.DSH_IMPORT = samples.join(';')

console.log(`[shot] electron: ${electronPath}`)
console.log(`[shot] 导入 ${samples.length} 个示例 EPUB，输出目录 ${shotDir}`)

// 本机 Chromium 沙箱无法初始化，必须显式关闭（与 npm run dev 的 --noSandbox 一致）
const child = spawn(electronPath, ['.', '--no-sandbox'], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => {
  console.log(`[shot] 退出码 ${code}`)
  process.exit(code ?? 0)
})
