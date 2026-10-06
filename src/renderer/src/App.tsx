import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { useApp } from './store/app'
import { Sidebar } from './components/Sidebar'
import { ConflictModal, SyncStatusModal } from './components/SyncModals'
import { Toaster } from './components/ui'
import { LibraryPage } from './pages/LibraryPage'
import { StatsPage } from './pages/StatsPage'
import { SettingsPage } from './pages/SettingsPage'
import { ReaderPage } from './pages/ReaderPage'

export default function App() {
  const ready = useApp((s) => s.ready)
  const route = useApp((s) => s.route)
  const theme = useApp((s) => s.settings?.theme ?? 'light')
  const init = useApp((s) => s.init)
  const importPaths = useApp((s) => s.importPaths)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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

  return (
    <>
      <div className="app">
        <Sidebar />
        <main className="main">
          {route === 'library' ? <LibraryPage /> : route === 'stats' ? <StatsPage /> : <SettingsPage />}
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

      <SyncStatusModal />
      <ConflictModal />
      <Toaster />
    </>
  )
}
