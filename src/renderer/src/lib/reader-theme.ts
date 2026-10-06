import type { ReaderTheme } from '@shared/types'

export interface ReaderThemeSpec {
  label: string
  bg: string
  text: string
  quote: string
  swatch: string
}

export const READER_THEMES: Record<ReaderTheme, ReaderThemeSpec> = {
  paper: { label: '纸白', bg: '#ffffff', text: '#1f2329', quote: '#e2e6eb', swatch: '#ffffff' },
  sepia: { label: '米黄', bg: '#f6efdf', text: '#3d3527', quote: '#ded0b2', swatch: '#f6efdf' },
  green: { label: '豆绿', bg: '#dbe8dc', text: '#26352a', quote: '#c1d4c3', swatch: '#dbe8dc' },
  night: { label: '夜间', bg: '#17191d', text: '#b9bfc8', quote: '#343941', swatch: '#17191d' }
}

export type FontKey = 'system' | 'serif' | 'kai' | 'hei'

export const FONT_STACKS: Record<FontKey, { label: string; css: string }> = {
  system: {
    label: '系统默认',
    css: "'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif"
  },
  serif: {
    label: '宋体 / 衬线',
    css: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', Georgia, serif"
  },
  kai: {
    label: '楷体',
    css: "'Kaiti SC', 'KaiTi', 'STKaiti', 'Noto Serif CJK SC', serif"
  },
  hei: {
    label: '黑体',
    css: "'Microsoft YaHei', 'SimHei', 'Noto Sans CJK SC', sans-serif"
  }
}
