import type { Settings } from '@shared/types'
import { accentPalette, mediaUrl } from './format'

/** 把主题色与自定义背景写到根节点，CSS 通过变量消费 */
export function applyAppearance(settings: Settings | null): void {
  const root = document.documentElement
  if (!settings) return

  const palette = accentPalette(settings.appearance.accent || '#3b6fd4', settings.theme === 'dark')
  root.style.setProperty('--primary', palette.primary)
  root.style.setProperty('--primary-hover', palette.hover)
  root.style.setProperty('--primary-soft', palette.soft)
  root.style.setProperty('--primary-soft-2', palette.soft2)

  const bg = settings.appearance.backgroundImage
  if (bg) {
    root.style.setProperty('--app-bg-image', `url("${mediaUrl(bg)}")`)
    root.style.setProperty('--app-bg-opacity', String(settings.appearance.backgroundOpacity ?? 0.18))
    root.dataset.hasBg = '1'
  } else {
    root.style.removeProperty('--app-bg-image')
    root.dataset.hasBg = '0'
  }
}

/** 阅读器背景图（阅读器自己消费，避免影响全局） */
export function readerBackground(settings: Settings | null): string | null {
  const image = settings?.appearance.readerBackgroundImage
  return image ? mediaUrl(image) : null
}
