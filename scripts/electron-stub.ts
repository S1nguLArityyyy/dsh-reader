/**
 * 测试用 electron 模块桩：让主进程代码能在纯 Node 下运行，
 * 用于在没有 Electron 运行时的环境里验证数据层 / 导入 / 阅读 / 统计链路。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = new Map<string, (...args: any[]) => any>()
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-app-'))

export const app = {
  getPath: (name: string) => (name === 'userData' ? join(tempRoot, 'userData') : join(tempRoot, name)),
  getVersion: () => '0.1.0-test',
  setName: () => undefined,
  getAppPath: () => process.cwd(),
  on: () => undefined,
  whenReady: async () => undefined,
  quit: () => undefined
}

export const ipcMain = {
  handle: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn)
  }
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showMessageBox: async () => ({ response: 1 })
}

export const shell = {
  openPath: async () => '',
  showItemInFolder: () => undefined,
  openExternal: async () => undefined
}

export const net = { fetch: async () => new Response('') }
export const protocol = {
  handle: () => undefined,
  registerSchemesAsPrivileged: () => undefined
}

/** 测试环境没有真实图像解码，返回空图即可 */
export const nativeImage = {
  createFromPath: () => ({
    isEmpty: () => true,
    resize: () => ({
      getSize: () => ({ width: 0, height: 0 }),
      toBitmap: () => Buffer.alloc(0)
    })
  })
}

export const BrowserWindow = class {
  static getAllWindows(): unknown[] {
    return []
  }
}

/** 供测试脚本调用注册好的 IPC 处理器 */
export function invokeHandler(channel: string, ...args: unknown[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`未注册的 IPC 通道：${channel}`)
  return Promise.resolve(fn({}, ...args))
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

export function tempDir(): string {
  return tempRoot
}
