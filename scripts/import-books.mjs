/**
 * 导入脚本的加载器：用 esbuild 把 import-books.ts 打成 .test/import-books.mjs 再跑。
 * 与 check-*.mjs 同一套做法（electron 用 stub 顶掉，不需要 Electron 运行时）。
 *
 * 用法：npm run import:books -- "D:\某个目录"
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'import-books.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'import-books.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  alias: { electron: join(root, 'scripts', 'electron-stub.ts') },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
