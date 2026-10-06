import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Upload } from 'lucide-react'
import { useApp, type Route } from './store/app'
import { Sidebar } from './components/Sidebar'
import { ConflictModal, SyncStatusModal } from './components/SyncModals'
import { Toaster } from './components/ui'
import { BookDetailModal } from './components/BookDetailModal'
import { LibraryPage } from './pages/LibraryPage'
import { StatsPage } from './pages/StatsPage'
import { SettingsPage } from './pages/SettingsPage'
import { ReaderPage } from './pages/ReaderPage'
import { applyAppearance } from './lib/appearance'

const ROUTE_ORDER: Record<Route, number> = { library: 0, stats: 1, settings: 2, reader: 3 }

function PageBody({ route }: { route: Route }) {
  if (route === 'stats') return <StatsPage />
  if (route === 'settings') return <SettingsPage />
  return <LibraryPage />
}

export default function App() {
  const ready = useApp((s) => s.ready)
  const route = useApp((s) => s.route)
  const theme = useApp((s) => s.settings?.theme ?? 'light')
  const settings = useApp((s) => s.settings)
  const init = useApp((s) => s.init)
  const importPaths = useApp((s) => s.importPaths)
  const [dragging, setDragging] = useState(false)
  const [prev, setPrev] = useState<{ route: Route; dir: number } | null>(null)
  const lastRoute = useRef<Route>(route)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    applyAppearance(settings)
  }, [settings])

  /* 页面切换：旧页面飞出、新页面飞入 */
  useEffect(() => {
    if (route === lastRoute.current) return
    const dir = ROUTE_ORDER[route] >= ROUTE_ORDER[lastRoute.current] ? 1 : -1
    setPrev({ route: lastRoute.current, dir })
    lastRoute.current = route
    const timer = window.setTimeout(() => setPrev(null), 260)
    return () => window.clearTimeout(timer)
  }, [route])

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) {
        depth += 1
        setDragging(true)
      }
    }
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (e: DragEvent): void => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths = files.map((file) => window.api.app.pathForFile(file)).filter((p) => p && p.length > 0)
      void importPaths(paths)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [importPaths])

  if (!ready) {
    return <div className="app" />
  }

  if (route === 'reader') {
    return (
      <>
        <ReaderPage />
        <SyncStatusModal />
        <ConflictModal />
        <Toaster />
      </>
    )
  }

  const dir = prev?.dir ?? 1

  return (
    <>
      <div className="app">
        <Sidebar />
        <main className="main">
          <div className="page-stack" style={{ '--dir': `${dir * 26}px` } as CSSProperties}>
            {prev ? (
              <div className="page-layer exiting" key={`prev-${prev.route}`}>
                <PageBody route={prev.route} />
              </div>
            ) : null}
            <div className="page-layer entering" key={route}>
              <PageBody route={route} />
            </div>
          </div>
        </main>
      </div>

      {dragging ? (
        <div className="drop-overlay">
          <div className="drop-hint">
            <Upload size={18} style={{ verticalAlign: -3, marginRight: 6 }} />
            松开以导入 EPUB 到书库
          </div>
        </div>
      ) : null}

      <BookDetailModal />
      <SyncStatusModal />
      <ConflictModal />
      <Toaster />
    </>
  )
}
