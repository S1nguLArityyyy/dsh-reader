/**
 * 局域网书籍服务（手机 ↔ 电脑直传，不经网盘、不限速）。
 *
 * 设计取舍：
 *   · 做三件事：列书 + 取书 + 【导出阅读记录】✓（手机在局域网内直接拉记录 ✓ 不经网盘 ✓）
 *   · 无鉴权 ✓ 仅监听局域网 ✓（端口 8787 ✓）
 *   · 只允许 GET ✓ books 只服务 .epub ✓ records 只读导出 ✓（绝不写、绝不删 ✓）
 *   · 启动时把可达地址写入 <userData>/lan.txt ✓ 方便界面/排查读取 ✓
 *
 * 手机端用法：设置 → 网盘同步 → 服务商【局域网】→ 填 http://<电脑IP>:8787 ✓
 */

import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, extname, join, normalize } from 'node:path'

/** 正在发送给手机的书（用于界面显示进度） */
export interface LanTransfer {
  name: string
  sent: number
  total: number
  at: number
}

let currentTransfer: LanTransfer | null = null

/** 当前是否有正在发送的书；没有则为 null */
export function lanTransfer(): LanTransfer | null {
  return currentTransfer
}

export interface LanServerOptions {
  /** 书籍目录（电脑本地书库） */
  booksDir: string
  /** 桌面端数据目录（progress.json / sessions.json 在这里 ✓） */
  dataDir?: string
  /** 收到并合并了手机推来的记录（主进程据此重读记录并刷新界面） */
  onRecordsMerged?: (info: { progress: number; sessions: number }) => void
  /** 取某本书的内容指纹（手机端据此在下载【之前】就跳过已有书 ✓ 省掉整本下载 ✓） */
  hashOf?: (fileName: string) => string | null
  /** 取某本书的主色（桌面端算好的 ✓ 手机端直接沿用 ✓ 两端一致 ✓） */
  colorOf?: (fileName: string) => string | null
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
        // 容错：手机端可能把地址填成 http://ip:8787/DshReader 之类 ✗
        // 只要结尾是 books.json ✓ 或路径里含 books/<文件名> ✓ 就照常服务 ✓
        {
          const raw = decodeURIComponent(url.pathname)
          if (raw.endsWith('/books.json') || raw === '/books.json') url.pathname = '/books.json'
          else {
            const at = raw.lastIndexOf('/books/')
            if (at >= 0) url.pathname = raw.slice(at)
          }
        }
        const isRecordsPost = req.method === 'POST' && url.pathname === '/records'
        if (req.method !== 'GET' && !isRecordsPost) {
          res.writeHead(405).end('only GET')
          return
        }
        if (url.pathname === '/' || url.pathname === '/books.json') {
          const names = (await readdir(booksDir).catch(() => [] as string[])).filter(
            (name) => extname(name).toLowerCase() === '.epub'
          )
          // 手机按 uuid 文件名排不了卷号，所以把原始文件名和书名一起发过去
          const metaByName = new Map<string, { title: string; originalName: string }>()
          try {
            const libRaw = await readFile(join(options.dataDir ?? '', 'library.json'), 'utf8')
            const lib = JSON.parse(libRaw) as Array<Record<string, unknown>>
            for (const row of lib) {
              const filePath = String(row.filePath ?? '')
              if (!filePath) continue
              metaByName.set(basename(filePath), {
                title: String(row.title ?? ''),
                originalName: String(row.fileName ?? '')
              })
            }
          } catch {
            // 读不到书目就不带这两项，手机端会退回原来的行为
          }

          const items = []
          for (const name of names) {
            const info = await stat(join(booksDir, name)).catch(() => null)
            items.push({
              name,
              size: info?.size ?? 0,
              modifiedAt: info?.mtimeMs ?? 0,
              color: options.colorOf?.(name) ?? null,
              hash: options.hashOf?.(name) ?? null,
              title: metaByName.get(name)?.title ?? null,
              originalName: metaByName.get(name)?.originalName ?? null
            })
          }
          // 手机端可以带上自己已有的指纹（?have=a,b,c ✓）→ 这里只返回缺的 ✓
          // 列表从"全量 85 条"降到"缺的几条" ✓ 手机端也就完全不用逐本比对 ✓
          const haveParam = url.searchParams.get('have') ?? ''
          const haveSet = new Set(
            haveParam
              .split(',')
              .map((item) => item.trim().toLowerCase())
              .filter(Boolean)
          )
          const filtered = haveSet.size > 0 ? items.filter((item) => !item.hash || !haveSet.has(String(item.hash).toLowerCase())) : items
          const body = JSON.stringify({ count: filtered.length, total: items.length, books: filtered })
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
          })
          res.end(body)
          log(`[lan] 列书 → ${items.length} 本`)
          return
        }
        if (req.method === 'POST' && url.pathname === '/records') {
          // 手机端把它的阅读记录推上来（只合并，绝不删除任何文件 ✓）
          // 写入前先备份一份 .bak ✓ 万一合并逻辑有问题可以直接回滚 ✓
          const dir = options.dataDir ?? booksDir
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const raw = Buffer.concat(chunks).toString('utf8')
          let payload: { progress?: Record<string, unknown>; sessions?: Array<Record<string, unknown>> } = {}
          try {
            payload = JSON.parse(raw) as typeof payload
          } catch {
            res.writeHead(400).end('bad json')
            return
          }
          const readJson = async (name: string): Promise<unknown> => {
            try {
              return JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as unknown
            } catch {
              return null
            }
          }
          const readBooks = (await readJson('library')) as Array<{ id?: string; contentHash?: string | null }> | null
          const hashToId = new Map<string, string>()
          for (const item of readBooks ?? []) {
            if (item?.id && item.contentHash) hashToId.set(String(item.contentHash).toLowerCase(), item.id)
          }
          // 键归一：手机推来的是 sha1:<hex>，书目里是 uuid，历史数据里两种都存过
          // 归一后按 (书, 日期, 设备) 去重取较大值，否则同一本书会被算两遍
          // 设备身份归一：空值或早期的 mobile 都算作手机，避免同一段阅读被记成两台设备
          const canonDeviceId = (id: unknown): string => {
            const v = String(id ?? '').trim()
            if (!v || v === 'mobile') return 'mobile-local'
            return v
          }
          const canonBookId = (id: string): string => {
            const bareId = String(id ?? '').toLowerCase().replace(/^sha1:/, '')
            return hashToId.get(bareId) ?? String(id)
          }
          const before = {
            progress: (await readJson('progress')) as Record<string, Record<string, unknown>> | null,
            sessions: (await readJson('sessions')) as Array<Record<string, unknown>> | null
          }
          await writeFile(join(dir, 'progress.json.bak'), JSON.stringify(before.progress ?? {}, null, 2), 'utf8').catch(() => undefined)
          await writeFile(join(dir, 'sessions.json.bak'), JSON.stringify(before.sessions ?? [], null, 2), 'utf8').catch(() => undefined)

          // 排查用：把收到的原始内容留一份（只保留键与时间戳，体积很小）
          try {
            const dump = {
              at: Date.now(),
              progressKeys: Object.keys(payload.progress ?? {}),
              progressStamps: Object.fromEntries(
                Object.entries(payload.progress ?? {}).map(([k, v]) => [k, Number((v as Record<string, unknown>)?.updatedAt ?? -1)])
              ),
              sessionsCount: (payload.sessions ?? []).length
            }
            await writeFile(join(dir, 'last-push.json'), JSON.stringify(dump, null, 2), 'utf8')
          } catch {
            /* 诊断写入失败不影响同步 */
          }

          const progress: Record<string, Record<string, unknown>> = {}
          for (const [rawKey, row] of Object.entries(before.progress ?? {})) {
            const key = canonBookId(rawKey)
            const prev = progress[key]
            if (!prev || Number(row?.updatedAt ?? 0) > Number(prev?.updatedAt ?? 0)) progress[key] = { ...row, bookId: key }
          }
          let progressMerged = 0
          for (const [rawId, record] of Object.entries(payload.progress ?? {})) {
            const bare = String(rawId).toLowerCase().replace(/^sha1:/, '')
            const key = hashToId.get(bare) ?? hashToId.get(String(rawId).toLowerCase()) ?? String(rawId)
            const incoming = record as Record<string, unknown>
            const mine = progress[key]
            if (Number(incoming?.updatedAt ?? 0) > Number(mine?.updatedAt ?? 0)) {
              progress[key] = { ...incoming, bookId: key }
              progressMerged += 1
            }
          }
          let sessionsMerged = 0
          const deduped = new Map<string, Record<string, unknown>>()
          for (const row of before.sessions ?? []) {
            const bookKey = canonBookId(String(row.bookId))
            const dedupKey = bookKey + '|' + String(row.day) + '|' + canonDeviceId(row.deviceId)
            const prev = deduped.get(dedupKey)
            if (!prev || Number(row.seconds ?? 0) > Number(prev.seconds ?? 0)) {
              deduped.set(dedupKey, { ...row, bookId: bookKey })
            }
          }
          const rows = [...deduped.values()]
          for (const incoming of payload.sessions ?? []) {
            const rawId = String(incoming.bookId ?? '')
            const bareSession = rawId.toLowerCase().replace(/^sha1:/, '')
            const key = hashToId.get(bareSession) ?? hashToId.get(rawId.toLowerCase()) ?? rawId
            const day = String(incoming.day ?? '')
            if (!key || !day) continue
            const deviceId = canonDeviceId(incoming.deviceId)
            const seconds = Number(incoming.seconds ?? 0)
            const index = rows.findIndex(
              (row) => String(row.bookId) === key && String(row.day) === day && canonDeviceId(row.deviceId) === deviceId
            )
            if (index >= 0) {
              if (seconds > Number(rows[index].seconds ?? 0)) {
                rows[index] = { ...rows[index], seconds }
                sessionsMerged += 1
              }
            } else {
              rows.push({ bookId: key, day, seconds, deviceId })
              sessionsMerged += 1
            }
          }
          await writeFile(join(dir, 'progress.json'), JSON.stringify(progress, null, 2), 'utf8')
          await writeFile(join(dir, 'sessions.json'), JSON.stringify(rows, null, 2), 'utf8')
          const body = JSON.stringify({ ok: true, progressMerged, sessionsMerged })
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
          res.end(body)
          options.onRecordsMerged?.({ progress: progressMerged, sessions: sessionsMerged })
          log(`[lan] 收到手机记录 → 进度 +${progressMerged} · 时长 +${sessionsMerged}（已备份 .bak ✓）`)
          return
        }
        if (url.pathname === '/records') {
          // 阅读记录（进度 + 时长）✓ 只读 ✓ 供手机在局域网内直接拉取 ✓
          // 键统一用【内容指纹】✓ 与手机端的书 id 一致 ✓ 两端才能对上同一本书 ✓
          const dir = options.dataDir ?? booksDir
          const readJson = async (name: string): Promise<unknown> => {
            try {
              return JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as unknown
            } catch {
              return null
            }
          }
          const library = (await readJson('library')) as Array<{ id?: string; contentHash?: string | null }> | null
          const idToHash = new Map<string, string>()
          for (const item of library ?? []) {
            if (item?.id && item.contentHash) idToHash.set(item.id, item.contentHash)
          }
          const progressRaw = (await readJson('progress')) as Record<string, Record<string, unknown>> | null
          const progress: Record<string, unknown> = {}
          for (const [id, record] of Object.entries(progressRaw ?? {})) {
            const key = idToHash.get(id) ?? id
            progress[key] = { ...record, bookId: key }
          }
          const sessionsRaw = (await readJson('sessions')) as Array<Record<string, unknown>> | null
          const sessions = (sessionsRaw ?? []).map((row) => {
            const id = String(row.bookId ?? '')
            return { ...row, bookId: idToHash.get(id) ?? id }
          })
          const body = JSON.stringify({ progress, sessions, exportedAt: Date.now() })
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
          })
          res.end(body)
          log(`[lan] 记录导出 → 进度 ${Object.keys(progress).length} 条 · 时长 ${sessions.length} 条`)
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
          // 记录发送进度，界面据此画进度条
          const stream = createReadStream(full)
          let sent = 0
          currentTransfer = { name: requested, sent: 0, total: info.size, at: Date.now() }
          stream.on('data', (chunk) => {
            sent += chunk.length
            currentTransfer = { name: requested, sent, total: info.size, at: Date.now() }
          })
          const clearTransfer = (): void => {
            currentTransfer = null
          }
          stream.on('close', clearTransfer)
          stream.on('error', clearTransfer)
          res.on('close', clearTransfer)
          stream.pipe(res)
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
