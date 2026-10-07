/**
 * 导出脚本的加载器：esbuild 打包 scripts/export-mobile-data.ts 再跑
 * （与 check-*.mjs / import-books.mjs 同一套做法，electron 用 stub 顶掉）
 *
 * 用法：node scripts/export-mobile-data.mjs <EPUB 路径> [输出目录]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'export-mobile-data.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'export-mobile-data.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  alias: { electron: join(root, 'scripts', 'electron-stub.ts') },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
