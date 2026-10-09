/**
 * 书签界面自检：esbuild 打包后在纯 Node + jsdom 下运行（无需 Electron）。
 * 用法：node scripts/bookmark-ui-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, '.test')
const outFile = join(testDir, 'bookmark-ui-check.mjs')

mkdirSync(testDir, { recursive: true })
await build({
  entryPoints: [join(root, 'scripts', 'bookmark-ui-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  // jsdom 留成外部依赖（它按包内路径加载资源，打进 bundle 反而会坏）
  external: ['jsdom'],
  // 渲染层用 @shared/* 指到 src/shared/*
  alias: { '@shared': join(root, 'src', 'shared') },
  // 渲染层的 tsx 用的是 React 17+ 的自动运行时（不 import React）
  jsx: 'automatic',
  loader: { '.css': 'empty', '.png': 'dataurl' },
  logLevel: 'warning'
})

execFileSync(process.execPath, [outFile, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  // 让渲染层 store 把实例挂到 globalThis，自检脚本与组件才共享同一份状态
  env: { ...process.env, DSH_UI_CHECK: '1' }
})
