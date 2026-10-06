import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 只跑渲染进程的 Vite 配置：用于在浏览器里预览界面（浏览器预览模式）。
 * 后端数据由 src/renderer/src/lib/mock-api.ts 提供，不落盘。
 */
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true
  },
  build: {
    outDir: resolve('out/web-preview'),
    emptyOutDir: true
  }
})
