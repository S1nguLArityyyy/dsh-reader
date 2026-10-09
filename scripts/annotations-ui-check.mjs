/**
 * 划线 / 笔记界面自检：esbuild 打包后在 jsdom 下运行（不需要 Electron）。
 * 用法：node scripts/annotations-ui-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'annotations-ui-check.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'annotations-ui-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  external: ['jsdom'],
  alias: { '@shared': join(root, 'src', 'shared') },
  jsx: 'automatic',
  loader: { '.css': 'empty', '.png': 'dataurl' },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DSH_UI_CHECK: '1' }
})
