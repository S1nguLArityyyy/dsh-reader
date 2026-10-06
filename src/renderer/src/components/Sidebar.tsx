import { BarChart3, BookMarked, BookOpen, Cloud, Library, Settings as SettingsIcon } from 'lucide-react'
import { useApp } from '../store/app'

export function Sidebar() {
  const route = useApp((s) => s.route)
  const go = useApp((s) => s.go)
  const sync = useApp((s) => s.sync)
  const setSyncModal = useApp((s) => s.setSyncModal)

  const inLibrary = route === 'library' || route === 'reader'

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
        <button className={`nav-item${inLibrary ? ' active' : ''}`} onClick={() => go('library')}>
          <BookOpen size={18} />
          <span>本地书库</span>
        </button>
      </nav>

      <div className="sidebar-foot">
        <button className="sync-pill" onClick={() => setSyncModal(true)} title="打开同步状态">
          <span className={`sync-dot${sync.loggedIn ? ' on' : ''}`} />
          <span>{sync.loggedIn ? `已连接 ${sync.account ?? ''}` : '网盘未连接'}</span>
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
