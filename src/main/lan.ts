/**
 * 局域网书籍服务（手机 ↔ 电脑直传，不经网盘、不限速）。
 *
 * 设计取舍：
 *   · 只做两件事：列书 + 取书 ✓（手机拿到 epub 后自己解析标题/封面 ✓ 所以不需要清单文件 ✓）
 *   · 无鉴权 ✓ 仅监听局域网 ✓（端口 8787 ✓）
 *   · 只允许 GET ✓ 且只服务 books 目录下的 .epub ✓（防目录穿越 ✓）
 *   · 启动时把可达地址写入 <userData>/lan.txt ✓ 方便界面/排查读取 ✓
 *
 * 手机端用法：设置 → 网盘同步 → 服务商【局域网】→ 填 http://<电脑IP>:8787 ✓
 */

import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, extname, join, normalize } from 'node:path'

export interface LanServerOptions {
  /** 书籍目录（电脑本地书库） */
  booksDir: string
  /** 写入地址信息的文件（可选） */
  infoFile?: string
  port?: number
  log?: (line: string) => void
}

export interface LanServerHandle {
  port: number
  urls: string[]
  close: () => Promise<void>
}

/** 本机所有非回环 IPv4 地址 */
function localAddresses(): string[] {
  const out: string[] = []
  const interfaces = networkInterfaces()
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address)
    }
  }
  return out
}

export async function startLanServer(options: LanServerOptions): Promise<LanServerHandle> {
  const port = options.port ?? 8787
  const booksDir = options.booksDir
  const log = options.log ?? (() => undefined)

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method !== 'GET') {
          res.writeHead(405).end('only GET')
          return
        }
        if (url.pathname === '/' || url.pathname === '/books.json') {
          const names = (await readdir(booksDir).catch(() => [] as string[])).filter(
            (name) => extname(name).toLowerCase() === '.epub'
          )
          const items = []
          for (const name of names) {
            const info = await stat(join(booksDir, name)).catch(() => null)
            items.push({ name, size: info?.size ?? 0, modifiedAt: info?.mtimeMs ?? 0 })
          }
          const body = JSON.stringify({ count: items.length, books: items })
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
          })
          res.end(body)
          log(`[lan] 列书 → ${items.length} 本`)
          return
        }
        if (url.pathname.startsWith('/books/')) {
          // 只取文件名部分 ✓ 彻底杜绝 ../ 穿越 ✓
          const requested = basename(decodeURIComponent(url.pathname.slice('/books/'.length)))
          if (extname(requested).toLowerCase() !== '.epub') {
            res.writeHead(400).end('bad name')
            return
          }
          const full = join(booksDir, normalize(requested))
          const info = await stat(full).catch(() => null)
          if (!info || !info.isFile()) {
            res.writeHead(404).end('not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/epub+zip',
            'Content-Length': info.size,
            'Cache-Control': 'no-store'
          })
          createReadStream(full).pipe(res)
          return
        }
        res.writeHead(404).end('not found')
      } catch (error) {
        res.writeHead(500).end(String(error))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve())
  })

  const urls = localAddresses().map((address) => `http://${address}:${port}`)
  if (options.infoFile) {
    const text = [`port=${port}`, `booksDir=${booksDir}`, ...urls].join('\n')
    await writeFile(options.infoFile, text, 'utf8').catch(() => undefined)
  }
  log(`[lan] 书籍直传服务已启动：${urls.join('  ') || '(未发现局域网地址)'}`)
  return {
    port,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}