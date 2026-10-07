/**
 * WebDAV provider 自检：用一台**内存版假 DAV 服务器**驱动真实 provider 与同步引擎。
 * 不需要联网、不需要真账号，所以能进 CI。
 *
 * 覆盖：MKCOL 逐级建目录与幂等、PUT/GET/DELETE、PROPFIND 解析（大小/时间/目录自身过滤）、
 * 百分号编码不被二次编码、路径穿越防护、401 → 认证失败、密码不入 settings.json，
 * 以及「两台设备共用一台 WebDAV」的端到端同步（进度 + 阅读时长）。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importMany } from '../src/main/library'
import { Store } from '../src/main/store'
import { SyncService } from '../src/main/sync'
import { CloudNotConnectedError, CloudPathError } from '../src/main/sync/provider'
import { WebDavProvider } from '../src/main/sync/webdav'
import { createSecretStore, SecretWriteError, type SecretStore } from '../src/main/sync/secret-store'
import type { Book, Progress } from '../src/shared/types'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 内存版假 DAV 服务器 ---------------- */

interface FakeNode {
  kind: 'dir' | 'file'
  data: Buffer
  modifiedAt: number
  children: Map<string, FakeNode>
}

function dir(modifiedAt = Date.now()): FakeNode {
  return { kind: 'dir', data: Buffer.alloc(0), modifiedAt, children: new Map() }
}

class FakeDav {
  readonly now = Date.now()
  readonly root = dir(this.now)
  readonly calls: Array<{ method: string; path: string }> = []
  username = 'me@example.com'
  password = 'app-password'
  /** 地址里的路径前缀（真服务器也会有，比如坚果云的 /dav） */
  readonly basePath = '/dav'

  /** URL pathname（百分号编码）→ 去掉地址前缀后的逻辑路径 */
  private toLogical(pathname: string): string {
    const decoded = decodeURIComponent(pathname)
    const withoutBase = decoded.startsWith(this.basePath) ? decoded.slice(this.basePath.length) : decoded
    return withoutBase || '/'
  }

  lookup(path: string): FakeNode | null {
    const segments = path.split('/').filter(Boolean)
    let node: FakeNode = this.root
    for (const segment of segments) {
      const child = node.children.get(segment)
      if (!child) return null
      node = child
    }
    return node
  }

  has(path: string): boolean {
    return Boolean(this.lookup(path))
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    // URL 里的 pathname 是百分号编码的，解一次就是逻辑路径（与 provider 的编码约定一致）
    const path = this.toLogical(new URL(input).pathname)
    this.calls.push({ method, path })

    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`
    if (headers.Authorization !== expected) return new Response('', { status: 401 })

    switch (method) {
      case 'PROPFIND':
        return this.propfind(path, String(headers.Depth ?? '0'))
      case 'MKCOL': {
        if (this.has(path)) return new Response('', { status: 405 })
        const parentPath = path.replace(/\/[^/]+\/?$/, '') || '/'
        const parent = this.lookup(parentPath)
        if (!parent) return new Response('', { status: 409 })
        parent.children.set(path.split('/').filter(Boolean).pop() as string, dir(Date.now()))
        return new Response('', { status: 201 })
      }
      case 'PUT': {
        const parentPath = path.replace(/\/[^/]+\/?$/, '') || '/'
        const parent = this.lookup(parentPath)
        if (!parent) return new Response('', { status: 409 })
        const name = path.split('/').filter(Boolean).pop() as string
        const existing = parent.children.get(name)
        const body = Buffer.from((init?.body as Uint8Array | undefined) ?? [])
        parent.children.set(name, {
          kind: 'file',
          data: body,
          modifiedAt: Date.now(),
          children: new Map()
        })
        return new Response(null, { status: existing ? 204 : 201 })
      }
      case 'GET': {
        const node = this.lookup(path)
        if (!node || node.kind !== 'file') return new Response('', { status: 404 })
        return new Response(new Uint8Array(node.data), { status: 200 })
      }
      case 'DELETE': {
        if (!this.has(path)) return new Response('', { status: 404 })
        const parentPath = path.replace(/\/[^/]+\/?$/, '') || '/'
        const parent = this.lookup(parentPath)
        parent?.children.delete(path.split('/').filter(Boolean).pop() as string)
        return new Response(null, { status: 204 })
      }
      default:
        return new Response('', { status: 405 })
    }
  }

  private propfind(path: string, depth: string): Response {
    const node = this.lookup(path)
    if (!node) return new Response('', { status: 404 })
    const base = path.replace(/\/+$/, '') || ''
    const targets: Array<{ path: string; node: FakeNode }> = [{ path: base, node }]
    if (depth !== '0' && node.kind === 'dir') {
      for (const [name, child] of node.children) targets.push({ path: `${base}/${name}`, node: child })
    }
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${targets.map((target) => this.responseXml(target.path, target.node)).join('\n')}
</D:multistatus>`
    return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
  }

  private responseXml(path: string, node: FakeNode): string {
    // 真 DAV 返回的 href 是**完整路径**（含地址里的前缀，如 /dav），这里照做
    const href =
      this.basePath +
      '/' +
      path.split('/').filter(Boolean).map(encodeURIComponent).join('/') +
      (node.kind === 'dir' ? '/' : '')
    return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype>${node.kind === 'dir' ? '<D:collection/>' : ''}</D:resourcetype>
        <D:getcontentlength>${node.kind === 'file' ? node.data.length : 0}</D:getcontentlength>
        <D:getlastmodified>${new Date(node.modifiedAt).toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`
  }
}

function memorySecrets(): SecretStore {
  let value: string | null = null
  return {
    load: () => value,
    has: () => value !== null,
    save: (next: string) => {
      value = next
    },
    clear: () => {
      value = null
    }
  }
}

/* ---------------- 环境准备 ---------------- */

const root = process.cwd()
const workDir = join(root, '.test', 'webdav')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

const samplesDir = join(root, 'samples')
const sampleFiles = readdirSync(samplesDir)
  .filter((file) => file.toLowerCase().endsWith('.epub'))
  .map((file) => join(samplesDir, file))
if (sampleFiles.length === 0) {
  console.error('samples 目录下没有 EPUB，请先运行 npm run samples')
  process.exit(1)
}

const DAV_URL = 'https://dav.example.com/dav'

/* ---------------- 1. provider 基本能力 ---------------- */
console.log('\n[1] provider 基本能力（MKCOL / PUT / GET / PROPFIND / DELETE）')
const server = new FakeDav()
const provider = new WebDavProvider({
  getConfig: () => ({ url: DAV_URL, username: server.username }),
  getPassword: () => server.password,
  fetchImpl: server.fetch
})

check(
  '未配置时 account() 为 null',
  (await new WebDavProvider({ getConfig: () => null, getPassword: () => null }).account()) === null
)
check(
  '只填地址没填密码时也算未连接',
  (await new WebDavProvider({ getConfig: () => ({ url: DAV_URL, username: 'x' }), getPassword: () => null }).account()) ===
    null
)

await provider.ensureDir('/DshReader/progress')
check('MKCOL 逐级建出目录', server.has('/DshReader') && server.has('/DshReader/progress'))
await provider.ensureDir('/DshReader/progress')
check('目录已存在时不报错（405 幂等）', true)

const payload = Buffer.from('{"x":1}', 'utf8')
await provider.write('/DshReader/progress/a.json', payload)
check('PUT 写入成功', server.lookup('/DshReader/progress/a.json')?.data.toString() === '{"x":1}')

const readBack = await provider.read('/DshReader/progress/a.json')
check('GET 读回内容一致', readBack?.toString() === '{"x":1}')
check('读不存在的文件返回 null（不是抛错）', (await provider.read('/DshReader/progress/none.json')) === null)

const listing = await provider.list('/DshReader/progress')
check(
  'PROPFIND Depth 1 解析出条目且不含目录自身',
  listing.length === 1 && listing[0].name === 'a.json',
  JSON.stringify(listing.map((entry) => entry.name))
)
check('条目带大小与修改时间', listing[0].size === payload.length && listing[0].modifiedAt > 0, `${listing[0].size} 字节`)

const info = await provider.stat('/DshReader/progress/a.json')
check('stat 返回元信息', info?.size === payload.length && info.kind === 'file')
check('stat 对不存在的路径返回 null', (await provider.stat('/DshReader/progress/none.json')) === null)

await provider.remove('/DshReader/progress/a.json')
check('DELETE 生效', !server.has('/DshReader/progress/a.json'))
await provider.remove('/DshReader/progress/a.json')
check('重复删除不报错（幂等）', true)

/* ---------------- 2. 编码与安全 ---------------- */
console.log('\n[2] 编码与安全')
await provider.ensureDir('/DshReader/progress')
await provider.write('/DshReader/progress/sha1%3Aabc.json', Buffer.from('{}'))
check(
  '带 % 的名字不会被二次编码（服务器上仍是原名，与本地 provider 一致）',
  server.has('/DshReader/progress/sha1%3Aabc.json')
)
const encoded = await provider.list('/DshReader/progress')
check(
  '列目录能把名字还原',
  encoded.some((entry) => entry.name === 'sha1%3Aabc.json'),
  JSON.stringify(encoded.map((entry) => entry.name))
)

let traversal = false
try {
  await provider.read('/../逃逸.json')
} catch (err) {
  traversal = err instanceof CloudPathError
}
check('拒绝 .. 路径穿越', traversal)

const wrongPassword = new WebDavProvider({
  getConfig: () => ({ url: DAV_URL, username: server.username }),
  getPassword: () => 'wrong-password',
  fetchImpl: server.fetch
})
let authFailed = false
try {
  await wrongPassword.stat('/DshReader')
} catch (err) {
  authFailed = err instanceof CloudNotConnectedError
}
check('401 映射成「认证失败」而不是普通错误', authFailed)

let notConfigured = false
try {
  await new WebDavProvider({ getConfig: () => null, getPassword: () => null }).list('/DshReader')
} catch (err) {
  notConfigured = err instanceof CloudNotConnectedError
}
check('未配置就调用 → CloudNotConnectedError', notConfigured)

// 密码文件写不进去时（沙箱降权 / 只读盘）退化成内存保存：本次运行仍可用
const blockerFile = join(workDir, 'blocker-file')
writeFileSync(blockerFile, 'x', 'utf8')
const brokenSecrets = createSecretStore(join(blockerFile, 'webdav-secret.json'))
let writeFailed = false
try {
  brokenSecrets.save('app-password')
} catch (err) {
  writeFailed = err instanceof SecretWriteError
}
check('密码文件写不进去时抛明确错误（不是裸的 EPERM）', writeFailed)
check('但本次运行内仍然可用（内存兜底）', brokenSecrets.load() === 'app-password')
brokenSecrets.clear()
check('退出登录不会因为删不掉文件而失败', brokenSecrets.load() === null)

/* ---------------- 3. 两台设备共用一台 WebDAV（端到端） ---------------- */
console.log('\n[3] 引擎端到端：两台设备共用同一台 WebDAV')
let clock = 1_700_000_000_000
const now = (): number => clock
const advance = (ms: number): void => {
  clock += ms
}

async function makeDevice(name: string): Promise<{ store: Store; books: Book[] }> {
  const deviceDir = join(workDir, name)
  process.env.DSH_BOOKS_DIR = join(deviceDir, 'books')
  const store = new Store(join(deviceDir, 'data'))
  await store.init()
  store.settings.deviceName = `设备${name}`
  const imported = await importMany(store, sampleFiles)
  if (imported.errors.length > 0) console.log(`    导入失败：${imported.errors.join(' / ')}`)
  return { store, books: store.books }
}

function setProgress(store: Store, bookId: string, percent: number, at: number): void {
  const record: Progress = {
    bookId,
    percent,
    chapterIndex: 1,
    chapterTitle: '第一章',
    scrollRatio: 0.4,
    updatedAt: at,
    deviceId: store.settings.deviceId,
    rev: 1
  }
  store.progress[bookId] = record
  store.save('progress')
}

const secrets = memorySecrets()
const a = await makeDevice('A')
check('设备A 导入示例书籍', a.books.length === sampleFiles.length, `${a.books.length} 本`)

advance(1000)
setProgress(a.store, a.books[0].id, 0.42, now())
a.store.addReadingTime(a.books[0].id, 600)

const syncA = new SyncService(a.store, { fetch: server.fetch, secretStore: secrets, now })
const connected = await syncA.configureWebdav({
  url: DAV_URL,
  username: server.username,
  password: server.password
})
check(
  '保存并连接后进入已连接状态（账号显示为 用户名 @ 主机）',
  connected.loggedIn && (connected.account ?? '').includes('me@example.com'),
  connected.account ?? ''
)
check(
  '首次同步把进度送上 WebDAV',
  connected.tasks.some((task) => task.kind === 'progress' && task.direction === 'up' && task.status === 'done'),
  connected.message ?? ''
)
check('首次同步把阅读时长也送上去', server.has('/DshReader/sessions') || connected.tasks.some((t) => t.kind === 'stats'))
check('云端出现 manifest 与设备登记', server.has('/DshReader/manifest.json') && server.has('/DshReader/devices'))

const settingsRaw = readFileSync(join(a.store.dataDir, 'settings.json'), 'utf8')
check('地址与账号写进 settings.json', settingsRaw.includes(DAV_URL) && settingsRaw.includes('me@example.com'))
check('应用密码**没有**写进 settings.json', !settingsRaw.includes(server.password))

const b = await makeDevice('B')
check('设备B 的书籍 uuid 与 A 不同', b.books[0].id !== a.books[0].id)
const syncB = new SyncService(b.store, { fetch: server.fetch, secretStore: secrets, now })
// 真实流程：每台设备各自在设置里填一次地址/账号/应用密码
const pulled = await syncB.configureWebdav({
  url: DAV_URL,
  username: server.username,
  password: server.password
})
check(
  '设备B 拉到进度（靠内容指纹对齐）',
  Math.abs((b.store.progress[b.books[0].id]?.percent ?? -1) - 0.42) < 1e-9,
  `${b.store.progress[b.books[0].id]?.percent}`
)
check(
  '设备B 也拿到了阅读时长',
  b.store.sessions.reduce((sum, row) => sum + row.seconds, 0) === 600,
  `${b.store.sessions.reduce((sum, row) => sum + row.seconds, 0)} 秒`
)
check('提示里报告了拉取结果', /下载/.test(pulled.message ?? ''), pulled.message ?? '')

// 幂等：没有变化时再同步一轮不应该产生任务
const idle = await syncA.run()
check('两端一致后不再产生任务', idle.tasks.filter((task) => task.status !== 'skipped').length === 0, idle.message ?? '')

// 退出登录后密码被清掉，状态回到未连接
const loggedOut = await syncA.logout()
check('退出登录后清掉应用密码', !secrets.has() && !loggedOut.loggedIn, loggedOut.message ?? '')

writeFileSync(join(workDir, 'check-ok.txt'), new Date().toISOString(), 'utf8')

console.log(`\n${failures === 0 ? '✅ WebDAV 链路全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
