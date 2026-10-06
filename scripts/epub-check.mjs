/**
 * EPUB 解析链路自检：不依赖 Electron，直接验证
 * 元数据 / 封面 / 目录 / 章节顺序 / 正文净化 是否正确。
 * 用法：node scripts/epub-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'epub-check.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'epub-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  // 解析链路会间接引入 electron（封面取色用 nativeImage），用桩替换
  alias: { electron: join(root, 'scripts', 'electron-stub.ts') },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
