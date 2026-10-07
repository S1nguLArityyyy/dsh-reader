/**
 * 同步引擎自检：用「本地文件夹」provider 模拟两台设备，跑通真实链路。
 *
 *   A 导入 → 上传进度 → B 导入（uuid 不同）→ 按内容指纹对上并拉取
 *   → B 更新 → A 拉取 → 两端都改 → 冲突弹窗数据 → 按选择落定 → 幂等
 *
 * 用法：node scripts/sync-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'sync-check.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'sync-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  alias: { electron: join(root, 'scripts', 'electron-stub.ts') },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile], { cwd: root, stdio: 'inherit' })
