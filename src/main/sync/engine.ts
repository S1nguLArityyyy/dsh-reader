/**
 * 同步引擎：只认 CloudProvider 接口，不关心底下是本地文件夹还是网盘。
 *
 * 当前范围：**阅读进度 + 阅读时长**。书籍文件本体留到后面（Book.syncUpload 字段已就位）。
 *
 * 云端目录结构（与既定路线一致）：
 *   <remoteDir>/manifest.json              书库清单（书名 / 进度 / 来源设备，供其它端与手机端读）
 *   <remoteDir>/progress/<键>.json          每本书一条进度（键 = 内容指纹，见 fingerprint.ts）
 *   <remoteDir>/sessions/<键>.json          每台设备每天的阅读时长（键 = 指纹 + 日期 + 设备）
 *   <remoteDir>/devices/<deviceId>.json     设备登记（最后在线时间、书籍数）
 *
 * 冲突判定：两端都改过同一本书（都比上次同步时间新）且进度不同 → 冲突。
 *  - 首次同步（没有上次同步时间）不做冲突判定，直接按更新时间新者胜，避免一上来就弹一堆冲突；
 *  - 同一台设备（deviceId 相同，例如重装后）永远按时间新者胜；
 *  - 冲突策略：ask 挂起等用户选，local / cloud 直接取舍。
 * 只有整轮没有挂起冲突时才推进「上次同步时间」，保证挂起期间判定窗口不变。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Book, ConflictItem, Progress, SessionRow, SyncState, SyncTask } from '../../shared/types'
import type { Store } from '../store'
import { bookSyncKey, ensureContentHashes } from './fingerprint'
import { cloudFileName, cloudKeyFromFileName, joinCloudPath, type CloudProvider } from './provider'

const SCHEMA = 1
/** 百分比差异小于这个值就认为进度一致，避免浮点噪声触发无意义同步 */
const PERCENT_EPSILON = 0.001

/** 云端 progress/<键>.json 的内容：Progress + 跨设备对齐用的键 */
interface CloudProgress extends Progress {
  schema: number
  bookKey: string
  deviceName?: string
}

/**
 * 云端 sessions/<键>.json：某台设备某本书某一天的阅读时长。
 * 键里带 deviceId，所以两台设备同一天读同一本书会各存一条 —— 展示时相加，
 * 同一台设备重复同步也不会翻倍。
 */
interface CloudSession {
  schema: number
  key: string
  bookKey: string
  day: string
  deviceId: string
  deviceName?: string
  bookId?: string
  /** 来源设备那一行的 id，拉取时沿用，保证各端 id 稳定 */
  id?: string
  seconds: number
  firstAt: number
  lastAt: number
}

/** 会话键用 \u0001 分隔，避免书名里出现分隔符造成歧义 */
const SESSION_SEP = '\u0001'
function sessionKeyOf(bookKey: string, day: string, deviceId: string): string {
  return `${bookKey}${SESSION_SEP}${day}${SESSION_SEP}${deviceId}`
}

interface ManifestBook {
  bookId: string
  title: string
  percent: number
  updatedAt: number
  deviceId: string
  deviceName?: string
}

interface CloudManifest {
  schema: number
  updatedAt: number
  deviceId: string
  books: Record<string, ManifestBook>
}

interface SyncMeta {
  schema: number
  lastSyncAt: number | null
}

type PlanAction = 'push' | 'pull' | 'skip' | 'conflict'

interface Plan {
  action: PlanAction
  /** 云端键（sha1:<hex> 或 title:<归一化书名>） */
  key: string
  /** 本机书籍 id；云端有而本机没有的书为 null */
  bookId: string | null
  title: string
  local: Progress | null
  cloud: CloudProgress | null
  bytes: number
  /** 冲突裁决产生的上传：写入时要用「裁决时刻」盖章，否则别的设备会按阅读时间把自己的旧值推回来 */
  force?: boolean
  note?: string
}

export interface SyncRunResult {
  state: SyncState
  conflicts: ConflictItem[]
}

export interface SyncRunOptions {
  /** 「全部下载」：忽略冲突判定，一律以云端为准 */
  preferCloud?: boolean
  /** 冲突弹窗的选择：本轮按它取舍 */
  policyOverride?: 'local' | 'cloud'
}

export interface SyncEngineOptions {
  store: Store
  /** 取当前 provider：取函数而不是实例，这样设置里切换云端类型时不用重建引擎 */
  provider: () => CloudProvider
  /** 云端同步文件夹（如 /DshReader）；每次运行重新读，跟随设置变化 */
  remoteDir: () => string
  conflictPolicy: () => 'ask' | 'local' | 'cloud'
  appVersion: string
  now?: () => number
  log?: (message: string) => void
  onState?: (state: SyncState) => void
}

export class SyncEngine {
  private state: SyncState = {
    phase: 'idle',
    loggedIn: false,
    account: null,
    lastSyncAt: null,
    tasks: [],
    transferred: 0,
    total: 0,
    message: null
  }

  private conflicts: ConflictItem[] = []
  private cancelled = false
  /** 正在跑一轮同步？自动同步与手动同步撞车时用来挡住后到的那次 */
  private running = false

  constructor(private readonly options: SyncEngineOptions) {}

  private get store(): Store {
    return this.options.store
  }

  private get provider(): CloudProvider {
    return this.options.provider()
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  status(): SyncState {
    return this.state
  }

  pendingConflicts(): ConflictItem[] {
    return this.conflicts
  }

  cancel(): SyncState {
    this.cancelled = true
    return this.patch({ phase: 'idle', message: '已取消同步' })
  }

  /** 启动时读一次上次同步时间，免得界面上一直显示「从未同步」 */
  async hydrate(): Promise<void> {
    const meta = await this.readMeta()
    this.patch({ lastSyncAt: meta.lastSyncAt })
  }

  async run(options: SyncRunOptions = {}): Promise<SyncRunResult> {
    if (this.running) return { state: this.state, conflicts: this.conflicts }
    this.running = true
    try {
      return await this.runOnce(options)
    } finally {
      this.running = false
    }
  }

  private async runOnce(options: SyncRunOptions = {}): Promise<SyncRunResult> {
    const startedAt = this.now()
    this.cancelled = false
    this.conflicts = []
    this.patch({ phase: 'checking', tasks: [], transferred: 0, total: 0, message: '正在读取云端进度…' })

    try {
      const account = await this.provider.account()
      if (!account) {
        return this.settle({
          phase: 'error',
          loggedIn: false,
          account: null,
          message: '尚未连接云端：请先选择作为云端的文件夹'
        })
      }

      const store = this.store
      const remoteDir = joinCloudPath(this.options.remoteDir() || '/DshReader')
      const progressDir = joinCloudPath(remoteDir, 'progress')
      const devicesDir = joinCloudPath(remoteDir, 'devices')
      const manifestPath = joinCloudPath(remoteDir, 'manifest.json')

      const meta = await this.readMeta()
      const lastSyncAt = meta.lastSyncAt ?? 0
      const policy = options.policyOverride ?? this.options.conflictPolicy()

      await this.provider.ensureDir(progressDir)
      await this.provider.ensureDir(devicesDir)

      /* 1) 补齐内容指纹：跨设备对齐同一本书的前提 */
      await ensureContentHashes(store, {
        shouldStop: () => this.cancelled,
        onProgress: (done, total) => this.patch({ message: `正在计算书籍指纹 ${done}/${total}…` })
      })
      if (this.cancelled) return this.settle({ phase: 'idle', message: '已取消同步' })

      /* 2) 云端现状 */
      this.patch({ message: '正在比对两端进度…' })
      const manifest = await this.readJson<CloudManifest>(manifestPath)
      const cloud = await this.readCloudProgress(progressDir)

      /* 3) 本机现状：书 → 云端键 */
      const localByKey = new Map<string, { book: Book; progress: Progress | null }>()
      for (const book of store.books) {
        const key = bookSyncKey(book)
        if (!localByKey.has(key)) localByKey.set(key, { book, progress: store.progress[book.id] ?? null })
      }

      /* 4) 逐键定计划 */
      const plans: Plan[] = []
      const keys = new Set<string>([...cloud.keys(), ...localByKey.keys()])
      for (const key of keys) {
        const localSide = localByKey.get(key)
        const cloudSide = cloud.get(key) ?? null
        const title = localSide?.book.title ?? manifest?.books?.[key]?.title ?? key.replace(/^[^:]*:/, '').slice(0, 24)

        if (!localSide) {
          // 云端有这本书、本机书库没有：不凭空造书，如实跳过
          plans.push({
            action: 'skip',
            key,
            bookId: null,
            title,
            local: null,
            cloud: cloudSide,
            bytes: 0,
            note: '这本书不在本机书库'
          })
          continue
        }

        const book = localSide.book
        const local = localSide.progress
        if (!local && !cloudSide) continue
        if (local && !cloudSide) {
          plans.push(this.makePlan('push', key, book, local, null, title))
          continue
        }
        if (!local && cloudSide) {
          plans.push(this.makePlan('pull', key, book, null, cloudSide, title))
          continue
        }
        if (!local || !cloudSide) continue

        const differ = Math.abs(local.percent - cloudSide.percent) >= PERCENT_EPSILON
        if (!differ) continue // 进度一致，不需要动

        const sameDevice = cloudSide.deviceId === store.settings.deviceId
        const localChanged = lastSyncAt > 0 && local.updatedAt > lastSyncAt
        const cloudChanged = lastSyncAt > 0 && cloudSide.updatedAt > lastSyncAt
        const conflict = !options.preferCloud && !sameDevice && localChanged && cloudChanged

        if (options.preferCloud) {
          plans.push(this.makePlan('pull', key, book, local, cloudSide, title))
        } else if (conflict && policy === 'local') {
          plans.push(this.makePlan('push', key, book, local, cloudSide, title, true))
        } else if (conflict && policy === 'cloud') {
          plans.push(this.makePlan('pull', key, book, local, cloudSide, title))
        } else if (conflict) {
          plans.push(this.makePlan('conflict', key, book, local, cloudSide, title))
        } else if (local.updatedAt >= cloudSide.updatedAt) {
          plans.push(this.makePlan('push', key, book, local, cloudSide, title))
        } else {
          plans.push(this.makePlan('pull', key, book, local, cloudSide, title))
        }
      }

      /* 5) 执行：挂起冲突先不动，其它项照做 */
      const actionable = plans.filter((plan) => plan.action === 'push' || plan.action === 'pull')
      const held = plans.filter((plan) => plan.action === 'conflict')
      const skipped = plans.filter((plan) => plan.action === 'skip')

      const tasks: SyncTask[] = [...actionable, ...skipped].map((plan) => this.toTask(plan))
      this.conflicts = held.map((plan) => this.toConflict(plan))
      let total = tasks.reduce((sum, task) => sum + task.total, 0)
      this.patch({
        phase: 'running',
        tasks: [...tasks],
        total,
        transferred: 0,
        message: tasks.length > 0 ? `共 ${tasks.length} 项任务` : '两端一致，无需同步'
      })

      let transferred = 0
      for (const plan of actionable) {
        if (this.cancelled) return this.settle({ phase: 'idle', message: '已取消同步' })
        const task = tasks.find((item) => item.id === plan.key)
        if (task) {
          task.status = 'active'
          this.patch({
            tasks: [...tasks],
            message: `${plan.action === 'push' ? '上传' : '下载'}：${plan.title}`
          })
        }
        try {
          const bytes = await this.apply(plan, progressDir)
          if (task) {
            task.status = 'done'
            task.done = bytes
          }
          transferred += bytes
        } catch (err) {
          if (task) task.status = 'error'
          this.options.log?.(`[sync]《${plan.title}》同步失败：${String(err)}`)
        }
        this.patch({ tasks: [...tasks], transferred })
      }

      /* 6) 阅读时长同步（主界面「今日阅读」与统计页的数字来源） */
      const statsBytes = await this.syncSessions(remoteDir, tasks)
      transferred += statsBytes
      total += statsBytes

      /* 7) 云端清单与设备登记 */
      await this.writeManifest(manifestPath, manifest, startedAt)
      await this.writeDevice(devicesDir, startedAt)

      const base: Partial<SyncState> = {
        loggedIn: true,
        account: account.name,
        tasks: [...tasks],
        total,
        transferred
      }

      if (held.length > 0) {
        // 有冲突挂起：不推进「上次同步时间」，判定窗口保持不变
        return this.settle({
          ...base,
          phase: 'conflict',
          lastSyncAt: meta.lastSyncAt,
          message: `${held.length} 本书两端都改过进度，请选择保留哪一边`
        })
      }

      await this.writeMeta({ schema: SCHEMA, lastSyncAt: startedAt })
      return this.settle({
        ...base,
        phase: 'done',
        lastSyncAt: startedAt,
        message: this.summarize(tasks)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.options.log?.(`[sync] 同步失败：${message}`)
      return this.settle({ phase: 'error', message: `同步失败：${message}` })
    }
  }

  private makePlan(
    action: PlanAction,
    key: string,
    book: Book,
    local: Progress | null,
    cloud: CloudProgress | null,
    title: string,
    force = false
  ): Plan {
    const record = action === 'pull' ? cloud : local
    const bytes = record ? Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8') : 0
    return { action, key, bookId: book.id, title, local, cloud, bytes, force }
  }

  /** 应用一条计划：上传写云端进度文件，下载写回本地 progress */
  private async apply(plan: Plan, progressDir: string): Promise<number> {
    if (plan.action === 'pull' && plan.cloud && plan.bookId) {
      this.store.progress[plan.bookId] = this.toLocalProgress(plan.cloud, plan.bookId)
      this.store.save('progress')
      return plan.bytes
    }
    if (plan.action === 'push' && plan.local && plan.bookId) {
      const local = plan.local
      const record: CloudProgress = {
        schema: SCHEMA,
        bookKey: plan.key,
        deviceName: this.store.settings.deviceName,
        ...local,
        bookId: plan.bookId,
        // 冲突裁决：盖「裁决时刻」并抬高 rev，否则别的设备会按阅读时间认定自己的更晚，
        // 把用户刚刚做出的选择又覆盖回去。
        ...(plan.force
          ? { updatedAt: this.now(), rev: Math.max(local.rev, plan.cloud?.rev ?? 0) + 1 }
          : {})
      }
      return await this.writeJson(joinCloudPath(progressDir, cloudFileName(plan.key)), record)
    }
    return 0
  }

  private toLocalProgress(cloud: CloudProgress, bookId: string): Progress {
    return {
      bookId,
      percent: cloud.percent,
      chapterIndex: typeof cloud.chapterIndex === 'number' ? cloud.chapterIndex : 0,
      chapterTitle: cloud.chapterTitle ?? '',
      scrollRatio: typeof cloud.scrollRatio === 'number' ? cloud.scrollRatio : 0,
      updatedAt: cloud.updatedAt,
      deviceId: cloud.deviceId,
      rev: typeof cloud.rev === 'number' ? cloud.rev : 0
    }
  }

  private toTask(plan: Plan): SyncTask {
    return {
      id: plan.key,
      kind: 'progress',
      bookId: plan.bookId ?? plan.key,
      title: plan.title,
      direction: plan.action === 'pull' ? 'down' : 'up',
      total: plan.bytes,
      done: 0,
      status: plan.action === 'skip' ? 'skipped' : 'pending'
    }
  }

  private toConflict(plan: Plan): ConflictItem {
    return {
      bookId: plan.bookId ?? plan.key,
      title: plan.title,
      localPercent: plan.local?.percent ?? 0,
      localAt: plan.local?.updatedAt ?? 0,
      localDevice: this.store.settings.deviceName,
      cloudPercent: plan.cloud?.percent ?? 0,
      cloudAt: plan.cloud?.updatedAt ?? 0,
      cloudDevice: plan.cloud?.deviceName ?? this.deviceLabel(plan.cloud?.deviceId)
    }
  }

  private deviceLabel(deviceId?: string): string {
    if (!deviceId) return '未知设备'
    if (deviceId === this.store.settings.deviceId) return this.store.settings.deviceName
    return `设备 ${deviceId.slice(0, 8)}`
  }

  private summarize(tasks: SyncTask[]): string {
    const done = (direction: SyncTask['direction'], kind: SyncTask['kind']): number =>
      tasks.filter(
        (task) => task.status === 'done' && task.direction === direction && task.kind === kind
      ).length
    const up = done('up', 'progress')
    const down = done('down', 'progress')
    const stats = done('up', 'stats') + done('down', 'stats')
    const skipped = tasks.filter((task) => task.status === 'skipped').length
    const failed = tasks.filter((task) => task.status === 'error').length

    const parts: string[] = []
    if (up > 0) parts.push(`上传 ${up} 本`)
    if (down > 0) parts.push(`下载 ${down} 本`)
    if (stats > 0) parts.push(`阅读时长 ${stats} 条`)
    if (skipped > 0) parts.push(`跳过 ${skipped} 项（不在本机书库）`)
    if (failed > 0) parts.push(`失败 ${failed} 项`)
    return parts.length > 0 ? `同步完成：${parts.join('、')}` : '已是最新，无需同步'
  }

  /**
   * 阅读时长同步：云端按 (书, 天, 设备) 各存一条，合并时取较大值。
   * 时长只增不减，所以不需要冲突裁决；两台设备同一天的时长天然相加。
   */
  private async syncSessions(remoteDir: string, tasks: SyncTask[]): Promise<number> {
    const store = this.store
    const dir = joinCloudPath(remoteDir, 'sessions')
    await this.provider.ensureDir(dir)

    const cloud = new Map<string, CloudSession>()
    for (const entry of await this.provider.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue
      const record = await this.readJson<CloudSession>(entry.path)
      if (!record || !this.isValidSession(record)) continue
      cloud.set(sessionKeyOf(record.bookKey, record.day, record.deviceId), record)
    }

    const byId = new Map<string, Book>()
    const byKey = new Map<string, Book>()
    for (const book of store.books) {
      byId.set(book.id, book)
      const key = bookSyncKey(book)
      if (!byKey.has(key)) byKey.set(key, book)
    }

    const localIndex = new Map<string, SessionRow>()
    for (const row of store.sessions) {
      const book = byId.get(row.bookId)
      if (!book) continue
      localIndex.set(
        sessionKeyOf(bookSyncKey(book), row.day, row.deviceId ?? store.settings.deviceId),
        row
      )
    }

    let bytes = 0
    let sessionsChanged = false
    const keys = new Set<string>([...cloud.keys(), ...localIndex.keys()])

    for (const key of keys) {
      const local = localIndex.get(key) ?? null
      const remote = cloud.get(key) ?? null
      const bookKey = remote?.bookKey ?? (local ? bookSyncKey(byId.get(local.bookId) as Book) : '')
      const day = remote?.day ?? local?.day ?? ''
      const book = (local ? byId.get(local.bookId) : undefined) ?? byKey.get(bookKey)

      if (!book) {
        // 云端有这本书的时长、本机书库没有：如实跳过，不凭空造书
        if (remote) tasks.push(this.sessionTask(key, `${day} 的阅读时长`, '', remote, 'down', 'skipped'))
        continue
      }

      const title = `${book.title} · ${day}`

      if (local && !remote) {
        const payload = this.toCloudSession(book, local)
        const written = await this.writeJson(joinCloudPath(dir, cloudFileName(key)), payload)
        bytes += written
        tasks.push(this.sessionTask(key, title, book.id, payload, 'up', 'done', written))
        continue
      }
      if (!remote) continue

      if (!local) {
        store.sessions.push(this.toLocalSession(remote, book.id))
        sessionsChanged = true
        const written = Buffer.byteLength(JSON.stringify(remote, null, 2), 'utf8')
        bytes += written
        tasks.push(this.sessionTask(key, title, book.id, remote, 'down', 'done', written))
        continue
      }

      if (remote.seconds > local.seconds) {
        local.seconds = remote.seconds
        local.firstAt = Math.min(local.firstAt || remote.firstAt, remote.firstAt || local.firstAt)
        local.lastAt = Math.max(local.lastAt, remote.lastAt)
        sessionsChanged = true
        const written = Buffer.byteLength(JSON.stringify(remote, null, 2), 'utf8')
        bytes += written
        tasks.push(this.sessionTask(key, title, book.id, remote, 'down', 'done', written))
      } else if (local.seconds > remote.seconds) {
        const payload = this.toCloudSession(book, local)
        const written = await this.writeJson(joinCloudPath(dir, cloudFileName(key)), payload)
        bytes += written
        tasks.push(this.sessionTask(key, title, book.id, payload, 'up', 'done', written))
      }
    }

    if (sessionsChanged) store.save('sessions')
    return bytes
  }

  private sessionTask(
    id: string,
    title: string,
    bookId: string,
    record: CloudSession,
    direction: SyncTask['direction'],
    status: SyncTask['status'],
    bytes = 0
  ): SyncTask {
    const size = bytes > 0 ? bytes : Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8')
    return {
      id,
      kind: 'stats',
      bookId,
      title,
      direction,
      total: size,
      done: status === 'skipped' ? 0 : size,
      status
    }
  }

  private toCloudSession(book: Book, row: SessionRow): CloudSession {
    const deviceId = row.deviceId ?? this.store.settings.deviceId
    const bookKey = bookSyncKey(book)
    return {
      schema: SCHEMA,
      key: sessionKeyOf(bookKey, row.day, deviceId),
      bookKey,
      day: row.day,
      deviceId,
      deviceName: deviceId === this.store.settings.deviceId ? this.store.settings.deviceName : undefined,
      bookId: book.id,
      id: row.id,
      seconds: row.seconds,
      firstAt: row.firstAt,
      lastAt: row.lastAt
    }
  }

  private toLocalSession(record: CloudSession, bookId: string): SessionRow {
    return {
      id: record.id ?? `sync-${record.deviceId}-${record.day}`,
      bookId,
      day: record.day,
      seconds: record.seconds,
      firstAt: record.firstAt,
      lastAt: record.lastAt,
      deviceId: record.deviceId
    }
  }

  private isValidSession(record: CloudSession): boolean {
    return (
      typeof record.bookKey === 'string' &&
      record.bookKey.length > 0 &&
      typeof record.day === 'string' &&
      record.day.length > 0 &&
      typeof record.deviceId === 'string' &&
      record.deviceId.length > 0 &&
      typeof record.seconds === 'number' &&
      Number.isFinite(record.seconds)
    )
  }

  private async readCloudProgress(progressDir: string): Promise<Map<string, CloudProgress>> {
    const map = new Map<string, CloudProgress>()
    const entries = await this.provider.list(progressDir)
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue
      const record = await this.readJson<CloudProgress>(entry.path)
      if (!record || !this.isValidProgress(record)) continue
      const key = typeof record.bookKey === 'string' && record.bookKey ? record.bookKey : cloudKeyFromFileName(entry.name)
      map.set(key, { ...record, bookKey: key })
    }
    return map
  }

  private isValidProgress(record: CloudProgress): boolean {
    return (
      typeof record.bookId === 'string' &&
      typeof record.percent === 'number' &&
      Number.isFinite(record.percent) &&
      typeof record.updatedAt === 'number' &&
      Number.isFinite(record.updatedAt)
    )
  }

  /** 清单：保留其它设备的条目，再用本机现状覆盖自己认识的键 */
  private async writeManifest(path: string, previous: CloudManifest | null, now: number): Promise<void> {
    const books: Record<string, ManifestBook> = { ...(previous?.books ?? {}) }
    for (const book of this.store.books) {
      const progress = this.store.progress[book.id]
      if (!progress) continue
      const key = bookSyncKey(book)
      const mine = progress.deviceId === this.store.settings.deviceId
      books[key] = {
        bookId: book.id,
        title: book.title,
        percent: progress.percent,
        updatedAt: progress.updatedAt,
        deviceId: progress.deviceId,
        deviceName: mine ? this.store.settings.deviceName : books[key]?.deviceName
      }
    }
    await this.writeJson(path, { schema: SCHEMA, updatedAt: now, deviceId: this.store.settings.deviceId, books })
  }

  private async writeDevice(devicesDir: string, now: number): Promise<void> {
    const { deviceId, deviceName } = this.store.settings
    await this.writeJson(joinCloudPath(devicesDir, cloudFileName(deviceId)), {
      schema: SCHEMA,
      deviceId,
      deviceName,
      appVersion: this.options.appVersion,
      bookCount: this.store.books.length,
      lastSeenAt: now
    })
  }

  private metaPath(): string {
    return join(this.store.syncDir, 'state.json')
  }

  private async readMeta(): Promise<SyncMeta> {
    try {
      const raw = await readFile(this.metaPath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<SyncMeta>
      return { schema: SCHEMA, lastSyncAt: typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : null }
    } catch {
      return { schema: SCHEMA, lastSyncAt: null }
    }
  }

  private async writeMeta(meta: SyncMeta): Promise<void> {
    const target = this.metaPath()
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8')
    await rename(tmp, target)
  }

  private async writeJson(path: string, data: unknown): Promise<number> {
    const buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
    await this.provider.write(path, buffer)
    return buffer.byteLength
  }

  private async readJson<T>(path: string): Promise<T | null> {
    const buffer = await this.provider.read(path)
    if (!buffer) return null
    try {
      return JSON.parse(buffer.toString('utf8')) as T
    } catch {
      return null
    }
  }

  private patch(patch: Partial<SyncState>): SyncState {
    this.state = { ...this.state, ...patch }
    this.options.onState?.(this.state)
    return this.state
  }

  private settle(patch: Partial<SyncState>): SyncRunResult {
    this.patch(patch)
    this.options.log?.(`[sync] ${this.state.phase}：${this.state.message ?? ''}`)
    return { state: this.state, conflicts: this.conflicts }
  }
}
