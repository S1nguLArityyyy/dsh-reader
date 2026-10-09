/**
 * 书签自检：与 epub-check 同一套路 —— esbuild 打包成单文件后在纯 Node 下跑，
 * electron 模块用桩替换。用法：node scripts/bookmarks-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'bookmarks-check.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'bookmarks-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  // 数据层会引入 electron（app.getPath / safeStorage），用桩替换
  alias: { electron: join(root, 'scripts', 'electron-stub.ts') },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
