import { resolve, sep } from 'node:path'

let dataRoot = ''

export function setDataRoot(dir: string): void {
  dataRoot = resolve(dir)
}

/** 自定义协议只允许访问数据目录内的文件 */
export function isInsideDataDir(target: string): boolean {
  if (!dataRoot) return false
  const abs = resolve(target)
  const root = dataRoot.toLowerCase()
  const value = abs.toLowerCase()
  return value === root || value.startsWith(root + sep)
}

/** 把本地绝对路径转成渲染进程可加载的 dsh:// 地址 */
export function toMediaUrl(absPath: string): string {
  return `dsh://media/${encodeURIComponent(absPath)}`
}
