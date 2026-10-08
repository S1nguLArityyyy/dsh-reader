import appIcon from '../assets/app-icon.png'
import { useEffect, useState, useMemo } from 'react'
import {
  BarChart3,
  BookMarked,
  BookOpen,
  ChevronDown,
  Layers,
  Library,
  Settings as SettingsIcon
} from 'lucide-react'
import { useApp } from '../store/app'
import { groupBooks, SINGLES_KEY } from '../lib/library'

export function Sidebar() {
  const route = useApp((s) => s.route)
  const go = useApp((s) => s.go)
  const info = useApp((s) => s.info)
  const refreshAll = useApp((s) => s.refreshAll)
  const [lanOpen, setLanOpen] = useState(false)
  const [lanBusy, setLanBusy] = useState(false)
  // 面板打开时重新取一次并轮询：启动时缓存的 info 里还没有局域网地址，服务是随后才起来的
  const [lan, setLan] = useState<Awaited<ReturnType<typeof window.api.app.info>> | null>(null)
  useEffect(() => {
    if (!lanOpen) return
    let alive = true
    const tick = (): void => {
      void window.api.app
        .info()
        .then((next) => {
          if (alive) setLan(next)
        })
        .catch(() => undefined)
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [lanOpen])
  const books = useApp((s) => s.books)
  const seriesFilter = useApp((s) => s.seriesFilter)
  const setSeriesFilter = useApp((s) => s.setSeriesFilter)
  const seriesOpen = useApp((s) => s.seriesOpen)
  const toggleSeries = useApp((s) => s.toggleSeries)
  const sync = useApp((s) => s.sync)
  const setSyncModal = useApp((s) => s.setSyncModal)

  const inLibrary = route === 'library' || route === 'reader'
  const groups = useMemo(() => groupBooks(books), [books])
  const visibleGroups = groups.filter((g) => g.books.length > 0)

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <img src={appIcon} alt="" />
        </div>
        <div className="brand-name">Dsh Reader</div>
      </div>

      <nav className="nav">
        <button className={`nav-item parent${inLibrary ? ' active' : ''}`} onClick={() => go('library')}>
          <Library size={18} />
          <span>书库</span>
        </button>
        <button className={`nav-item${route === 'stats' ? ' active' : ''}`} onClick={() => go('stats')}>
          <BarChart3 size={18} />
          <span>统计</span>
        </button>
      </nav>

      <div className="nav-caption">书库</div>

      <nav className="nav">
        <button
          className={`nav-item${inLibrary && !seriesFilter ? ' active' : ''}`}
          onClick={() => setSeriesFilter(null)}
        >
          <BookOpen size={18} />
          <span>本地书库</span>
          <span className="nav-count">{books.length}</span>
          <span
            className={`nav-chevron${seriesOpen ? ' open' : ''}`}
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              toggleSeries()
            }}
            title={seriesOpen ? '收起系列' : '展开系列'}
          >
            <ChevronDown size={15} />
          </span>
        </button>
      </nav>

      <div className={`nav-children${seriesOpen && visibleGroups.length > 0 ? ' open' : ''}`}>
        <div className="nav-children-inner">
          {visibleGroups.map((group) => (
            <button
              key={group.key}
              className={`nav-child${seriesFilter === group.key ? ' active' : ''}`}
              onClick={() => setSeriesFilter(group.key)}
              title={group.title}
            >
              {group.key === SINGLES_KEY ? <BookOpen size={14} /> : <Layers size={14} />}
              <span className="nav-child-label">{group.title}</span>
              <span className="nav-count">{group.books.length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-foot">
        <button className="sync-pill" onClick={() => setLanOpen(true)} title="局域网服务状态">
          <span className={`sync-dot${lan?.lanUrl ? ' on' : ''}`} />
          <span className="sync-label">{lan?.lanUrl ? `局域网 ${lan!.lanUrl.replace(/^https?:\/\//, '')}` : '局域网未启动'}</span>
        </button>
        {lanOpen ? (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 900 }}
            onClick={() => setLanOpen(false)}
          >
            <div
              style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 440, background: 'var(--panel)', borderRadius: 14, padding: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ margin: '0 0 14px' }}>局域网服务</h3>
              <div className="setting-row">
                <div>
                  <div className="setting-label">服务地址</div>
                  <div className="setting-desc">{lan?.lanUrl || '未启动'}</div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">最近收到手机记录</div>
                  <div className="setting-desc">
                    {lan?.lastRecordPush?.at
                      ? new Date(lan.lastRecordPush.at).toLocaleString() + ` · 进度 +${lan.lastRecordPush.progress} · 时长 +${lan.lastRecordPush.sessions}`
                      : '还没有'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={lanBusy}
                  onClick={() => {
                    setLanBusy(true)
                    void window.api.lan
                      .reloadRecords()
                      .then(() => refreshAll())
                      .finally(() => setLanBusy(false))
                  }}
                >
                  重新读取记录
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => void window.api.lan.openBooksDir()}>
                  打开书籍目录
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setLanOpen(false)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <button className={`nav-item${route === 'settings' ? ' active' : ''}`} onClick={() => go('settings')}>
          <SettingsIcon size={18} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
