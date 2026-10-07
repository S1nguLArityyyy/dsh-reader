import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

if (typeof window.api === 'undefined') {
}

// 阻止把文件拖到窗口时 Electron 直接导航到该文件
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

createRoot(container).render(<App />)
