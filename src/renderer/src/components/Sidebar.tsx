import { useMemo } from 'react'
import {
  BarChart3,
  BookMarked,
  BookOpen,
  ChevronDown,
  Cloud,
  Layers,
  Library,
  Settings as SettingsIcon
} from 'lucide-react'
import { useApp } from '../store/app'
import { groupBooks, SINGLES_KEY } from '../lib/library'

export function Sidebar() {
  const route = useApp((s) => s.route)
  const go = useApp((s) => s.go)
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
          <BookMarked size={19} />
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
        <button className="sync-pill" onClick={() => setSyncModal(true)} title="打开同步状态">
          <span className={`sync-dot${sync.loggedIn ? ' on' : ''}`} />
          <span className="sync-label">{sync.loggedIn ? `已连接 ${sync.account ?? ''}` : '网盘未连接'}</span>
          <Cloud size={15} />
        </button>
        <button className={`nav-item${route === 'settings' ? ' active' : ''}`} onClick={() => go('settings')}>
          <SettingsIcon size={18} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
