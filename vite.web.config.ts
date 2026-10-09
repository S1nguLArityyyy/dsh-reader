import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 只跑渲染进程的 Vite 配置：用于在浏览器里预览界面（浏览器预览模式）。
 *
 * ⚠️ 注意：渲染层现在只从 preload 注入的 window.api 取数据，没有任何浏览器兜底实现，
 * 所以在浏览器里打开会停在初始化（window.api 为 undefined）。这条链路仅作开发期脚手架保留，
 * 要真正可用需要另写一份内存版 api。
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
