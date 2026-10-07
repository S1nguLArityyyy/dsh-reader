import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CloudDownload, RefreshCw } from 'lucide-react'
import { useApp } from '../store/app'
import { formatDateTime, fileSizeText } from '../lib/format'
import { Modal } from './ui'

/** 同步状态弹窗（对齐参考图三：任务计数、进度条、上次同步时间、已传大小、三个操作） */
export function SyncStatusModal() {
  const open = useApp((s) => s.syncModalOpen)
  const sync = useApp((s) => s.sync)
  const setOpen = useApp((s) => s.setSyncModal)
  const runSync = useApp((s) => s.runSync)
  const cancelSync = useApp((s) => s.cancelSync)
  const downloadAll = useApp((s) => s.downloadAll)
  const connectSync = useApp((s) => s.connectSync)

  const total = sync.tasks.length
  const done = sync.tasks.filter((t) => t.status === 'done').length
  const active = sync.tasks.find((t) => t.status === 'active')
  const busy = sync.phase === 'running' || sync.phase === 'checking'

  // 让用户看得出"在跑还是卡住"：已用时 / 实时速度 / 30 秒无进展告警（只用 SyncState 已有字段 ✓）
  const [nowTick, setNowTick] = useState(Date.now())
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [lastProgress, setLastProgress] = useState({ at: 0, bytes: 0 })
  const [speed, setSpeed] = useState(0)

  useEffect(() => {
    if (!busy) {
      setStartedAt(null)
      setSpeed(0)
      return
    }
    setStartedAt((v) => v ?? Date.now())
    const timer = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  useEffect(() => {
    const now = Date.now()
    const bytes = sync.transferred
    setLastProgress((prev) => {
      if (prev.at > 0 && bytes > prev.bytes) {
        const dt = (now - prev.at) / 1000
        if (dt > 0.3) setSpeed((bytes - prev.bytes) / dt)
      }
      return { at: now, bytes }
    })
  }, [sync.transferred])

  const elapsedSec = startedAt ? Math.max(0, Math.floor((nowTick - startedAt) / 1000)) : 0
  const elapsedText = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)} 分 ${elapsedSec % 60} 秒` : `${elapsedSec} 秒`
  const stalled = busy && lastProgress.at > 0 && nowTick - lastProgress.at > 30000 && speed === 0
  const recent = sync.tasks.slice(-6).reverse()
  const percent = total > 0 ? done / total : busy ? 0.05 : 0

  const label = active
    ? `${active.direction === 'up' ? '上传' : '下载'}：${active.title}`
    : total === 0
      ? '没有任务'
      : `已完成 ${done} 项`

  return (
    <Modal open={open} title="同步状态" onClose={() => setOpen(false)} width={520}>
      <div className="sync-line">
        <span>{label}</span>
        <span className="sync-count">
          {done}/{total}
        </span>
      </div>

      <div className="pbar" style={{ marginTop: 10 }}>
        <i style={{ width: `${Math.round(percent * 100)}%` }} />
      </div>

      <div className="sync-line" style={{ marginTop: 14 }}>
        <span>上次同步时间：{formatDateTime(sync.lastSyncAt)}</span>
        <span className="sync-size">
          {fileSizeText(sync.transferred)} / {fileSizeText(sync.total)}
        </span>
      </div>

      {sync.message ? (
        <div className="setting-hint" style={{ marginTop: 14 }}>
          {sync.message}
        </div>
      ) : null}

        {busy || elapsedSec > 0 ? (
          <div className="sync-line" style={{ marginTop: 12 }}>
            <span>已用时：{elapsedText}</span>
            <span className="sync-size">{speed > 0 ? `${fileSizeText(speed)}/s` : "—"}</span>
          </div>
        ) : null}

        {stalled ? (
          <div className="setting-hint" style={{ marginTop: 10, color: "#d9534f" }}>
            ⚠ 已 30 秒没有字节增长 —— 可能卡住了，可以点「取消同步」后重试
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div className="setting-label" style={{ marginBottom: 6 }}>最近任务</div>
            {recent.map((task) => {
              const mark =
                task.status === "done" ? "✓" : task.status === "error" ? "✗" : task.status === "skipped" ? "·" : "…"
              return (
                <div key={task.id} className="sync-line" style={{ fontSize: 12, opacity: 0.85 }}>
                  <span>
                    {mark} {task.direction === "up" ? "上传" : "下载"}：{task.title}
                  </span>
                  <span className="sync-size">{task.status}</span>
                </div>
              )
            })}
          </div>
        ) : null}

      <div className="sync-actions">
        <button className="btn btn-primary" onClick={() => void runSync()} disabled={busy}>
          <RefreshCw size={15} />
          立即同步
        </button>
        <button className="btn btn-ghost" onClick={() => void cancelSync()} disabled={!busy}>
          取消同步
        </button>
      </div>

      <button className="btn btn-ghost btn-block" onClick={() => void downloadAll()}>
        <CloudDownload size={15} />
        全部下载云端书籍
      </button>

      {!sync.loggedIn ? (
        <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => void connectSync()}>
          连接云端
        </button>
      ) : null}
    </Modal>
  )
}

/** 冲突弹窗：逐本选择保留本地还是使用云端 */
export function ConflictModal() {
  const open = useApp((s) => s.conflictModalOpen)
  const conflicts = useApp((s) => s.conflicts)
  const preview = useApp((s) => s.conflictPreview)
  const setOpen = useApp((s) => s.setConflictModal)
  const resolve = useApp((s) => s.resolveConflicts)

  const [choice, setChoice] = useState<Record<string, 'local' | 'cloud'>>({})

  const defaults = useMemo(() => {
    const map: Record<string, 'local' | 'cloud'> = {}
    for (const item of conflicts) map[item.bookId] = item.localAt >= item.cloudAt ? 'local' : 'cloud'
    return map
  }, [conflicts])

  useEffect(() => {
    setChoice(defaults)
  }, [defaults])

  const applyAll = (value: 'local' | 'cloud'): void => {
    const map: Record<string, 'local' | 'cloud'> = {}
    for (const item of conflicts) map[item.bookId] = value
    setChoice(map)
  }

  return (
    <Modal
      open={open}
      title="发现阅读进度冲突"
      onClose={() => setOpen(false)}
      width={620}
      titleExtra={
        preview ? (
          <span className="conflict-preview-badge">
            <AlertTriangle size={12} />
            设计预览数据
          </span>
        ) : null
      }
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => applyAll('local')}>
            全部保留本地
          </button>
          <button className="btn btn-ghost" onClick={() => applyAll('cloud')}>
            全部使用云端
          </button>
          <div className="reader-spacer" style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={() => void resolve(choice[conflicts[0]?.bookId ?? ''] ?? 'local')}>
            确认并同步
          </button>
        </>
      }
    >
      <p className="conflict-desc">
        以下书籍在本地与云端都有更新，请选择要保留的进度。选择后另一端会在下次同步时被覆盖。
      </p>

      {conflicts.map((item) => (
        <div className="conflict-item" key={item.bookId}>
          <div className="conflict-title">{item.title}</div>
          <div className="conflict-options">
            <button
              className={`conflict-opt${choice[item.bookId] === 'local' ? ' active' : ''}`}
              onClick={() => setChoice((prev) => ({ ...prev, [item.bookId]: 'local' }))}
            >
              <b>保留本地</b>
              <small>
                进度 {Math.round(item.localPercent * 100)}%
                <br />
                {formatDateTime(item.localAt)}
                <br />
                设备：{item.localDevice}
              </small>
            </button>
            <button
              className={`conflict-opt${choice[item.bookId] === 'cloud' ? ' active' : ''}`}
              onClick={() => setChoice((prev) => ({ ...prev, [item.bookId]: 'cloud' }))}
            >
              <b>使用云端</b>
              <small>
                进度 {Math.round(item.cloudPercent * 100)}%
                <br />
                {formatDateTime(item.cloudAt)}
                <br />
                设备：{item.cloudDevice}
              </small>
            </button>
          </div>
        </div>
      ))}

      {conflicts.length === 0 ? <div className="setting-hint">当前没有冲突记录。</div> : null}
    </Modal>
  )
}
