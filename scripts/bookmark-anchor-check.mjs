/**
 * 书签锚点自检：esbuild 打包后在纯 Node 下跑（jsdom 提供 DOM）。
 * 用法：node scripts/bookmark-anchor-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'bookmark-anchor-check.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'bookmark-anchor-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  external: ['jsdom'],
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' })
