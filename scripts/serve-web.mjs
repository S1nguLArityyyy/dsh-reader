/**
 * 极简静态服务器：用于预览 npm run build:web 的产物（浏览器预览模式）。
 * 不监听文件变化，避免编辑器/工具的临时文件导致 watcher 崩溃。
 * 用法：node scripts/serve-web.mjs [port]
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = join(root, 'out', 'web-preview')
const port = Number(process.argv[2] ?? process.env.PORT ?? 5199)

if (!existsSync(join(webRoot, 'index.html'))) {
  console.error('未找到 out/web-preview/index.html，请先运行 npm run build:web')
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  let target = join(webRoot, rel)
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(target) || statSync(target).isDirectory()) target = join(webRoot, 'index.html')
  try {
    const body = readFileSync(target)
    res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' })
    res.end(body)
  } catch (err) {
    res.writeHead(500).end(String(err))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[serve-web] 浏览器预览已启动：http://127.0.0.1:${port}`)
})
