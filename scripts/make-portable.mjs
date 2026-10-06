/**
 * 把 electron-builder 的 --dir 产物整理成一个可直接双击、可直接打包发送的文件夹：
 *   release/DshReader-<版本>-portable/
 *       DshReader.exe      双击打开
 *       使用说明.txt
 *       resources/ ...     应用文件
 *
 * 用法：node scripts/make-portable.mjs
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(
  await import('node:fs/promises').then((fs) => fs.readFile(join(root, 'package.json'), 'utf8'))
).version

const src = join(root, 'release', 'win-unpacked')
const dest = join(root, 'release', `DshReader-${version}-portable`)

if (!existsSync(join(src, 'DshReader.exe'))) {
  console.error('未找到 release/win-unpacked/DshReader.exe，请先运行 npm run dist:dir')
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
renameSync(src, dest)

const readme = `Dsh Reader ${version} — 免安装版
=====================================

【怎么用】
双击 DshReader.exe 打开。
第一次打开会自动在本文件夹里建一个 books\\ 目录。

【重要】
请把这个文件夹放在开发项目目录之外再运行（例如 D:\\DshReader）。
实测若直接从项目的 release 目录里双击，Electron 会启动失败。
压缩发给别人不受影响 —— 对方解压到任意位置都能用。

【文件放在哪】
· 书籍       本文件夹的 books\\   —— 导入时会从原位置复制一份过来，原文件不动
· 封面缓存   本文件夹（首次打开后自动生成）
· 阅读进度   %APPDATA%\\Dsh Reader   —— 阅读进度、阅读统计、个人设置

【分享给别人】
把整个文件夹压缩后发给对方，对方解压后双击 DshReader.exe 即可使用，
不需要安装，也不需要装任何运行环境。
注意：书库、阅读进度不会跟着走 —— 对方打开时是干净的书库。

【卸载】
直接删除整个文件夹即可，不留残余。

【支持格式】
当前版本支持 EPUB。
`

writeFileSync(join(dest, '使用说明.txt'), readme, 'utf8')

// 预建 books 目录，让「书放哪」一眼可见
mkdirSync(join(dest, 'books'), { recursive: true })

console.log(`[portable] 已生成：${dest}`)

/**
 * 自动部署到项目目录之外。
 * 实测：exe 位于本项目目录内时，Electron 主进程会在 app ready 之前崩溃（0xC0000003 / 0xC0000005），
 * 放到项目外任意位置（含带空格、带中文的路径）都能正常启动。
 */
const deployDir = process.env.DSH_DEPLOY_DIR ?? join(`${root.slice(0, 3)}`, 'DshReaderApp')
const insideProject = resolve(deployDir).toLowerCase().startsWith(resolve(root).toLowerCase())

if (insideProject) {
  console.log(`[portable] 部署目录在项目内（${deployDir}），跳过自动部署`)
} else {
  try {
    rmSync(deployDir, { recursive: true, force: true })
    cpSync(dest, deployDir, { recursive: true })
    console.log(`[portable] 已部署到：${deployDir}`)
    console.log(`[portable] 双击 ${join(deployDir, 'DshReader.exe')} 即可运行`)
  } catch (err) {
    console.log(`[portable] 自动部署失败（不影响项目内产物）：${String(err)}`)
  }
}
