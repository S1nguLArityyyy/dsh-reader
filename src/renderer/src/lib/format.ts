/** 通用格式化工具 */

export function mediaUrl(absPath: string): string {
  return `dsh://media/${encodeURIComponent(absPath)}`
}

export interface DurationPart {
  value: string
  unit: string
}

/** "10 分 34 秒" 拆成可分别设置字号的片段 */
export function durationParts(seconds: number): DurationPart[] {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts: DurationPart[] = []
  if (hours > 0) parts.push({ value: String(hours), unit: '小时' })
  if (minutes > 0 || hours > 0) parts.push({ value: String(minutes), unit: '分' })
  parts.push({ value: String(secs), unit: '秒' })
  return parts
}

export function durationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  // 超过一小时就不再显示秒，避免「3小时21分0秒」这种啰嗦写法
  if (total >= 3600) {
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`
  }
  return durationParts(total)
    .map((p) => `${p.value}${p.unit}`)
    .join('')
}

/** 长文本形式，用于「剩余时间：19 分钟」 */
export function remainingText(seconds: number | null): string {
  if (seconds === null) return '暂无数据'
  if (seconds < 60) return '不到 1 分钟'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

export function clockText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}分${String(secs).padStart(2, '0')}秒`
}

export function percentText(percent: number): number {
  return Math.round(Math.min(1, Math.max(0, percent)) * 100)
}

export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDateTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 由字符串生成稳定的色相，用于封面兜底与卡片配色（FNV-1a，分布均匀） */
export function hueOf(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % 360
}

export function gradientOf(seed: string, dark = false): string {
  const hue = hueOf(seed)
  if (dark) {
    return `linear-gradient(135deg, hsl(${hue} 30% 25%), hsl(${(hue + 24) % 360} 34% 14%))`
  }
  return `linear-gradient(155deg, hsl(${hue} 32% 46%), hsl(${(hue + 22) % 360} 36% 28%))`
}

/* ---------------- 字数与颜色 ---------------- */

/** 96000 → 9.6 万字 */
export function formatWordCount(count: number): string {
  if (!count || count <= 0) return '—'
  if (count < 10000) return `${count} 字`
  const wan = count / 10000
  return `${wan >= 100 ? Math.round(wan) : Number(wan.toFixed(1))} 万字`
}

export interface Hsl {
  h: number
  s: number
  l: number
}

export function hexToHsl(hex: string): Hsl {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

export function hsl(h: number, s: number, l: number, alpha = 1): string {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.max(0, Math.min(100, s))
  const light = Math.max(0, Math.min(100, l))
  return alpha >= 1 ? `hsl(${hue} ${sat}% ${light}%)` : `hsl(${hue} ${sat}% ${light}% / ${alpha})`
}

export interface AccentPalette {
  primary: string
  hover: string
  soft: string
  soft2: string
  onPrimary: string
}

/** 由主题色推导出一组界面用色 */
export function accentPalette(hex: string, dark: boolean): AccentPalette {
  const { h, s, l } = hexToHsl(hex)
  const sat = Math.max(12, Math.min(92, s))
  const base = Math.max(28, Math.min(66, l))
  return {
    primary: hsl(h, sat, base),
    hover: hsl(h, sat, Math.max(18, base - 8)),
    soft: dark ? hsl(h, Math.min(60, sat), 16) : hsl(h, Math.min(90, sat + 6), 95),
    soft2: dark ? hsl(h, Math.min(60, sat), 24) : hsl(h, Math.min(90, sat + 4), 88),
    onPrimary: l > 62 ? hsl(h, sat, 12) : '#ffffff'
  }
}

/** 把封面主色转成「左深右浅」的卡片渐变（右侧融进面板色，用于今日阅读卡） */
export function coverFade(color: string | null, fallbackSeed: string): string {
  const base = color ?? hsl(hueOf(fallbackSeed), 34, 42)
  const { h, s, l } = hexToHsl(base)
  return `linear-gradient(100deg, ${hsl(h, s, Math.max(18, l - 6))} 0%, ${hsl(h, s * 0.92, Math.max(20, l))} 42%, ${hsl(
    h,
    s * 0.72,
    Math.max(22, l + 8),
    0.78
  )} 56%, var(--panel) 70%)`
}

/** 由封面主色生成一整块彩色渐变（详情弹窗头部，白字始终可读） */
export function coverHero(color: string | null, fallbackSeed: string): string {
  const base = color ?? hsl(hueOf(fallbackSeed), 34, 42)
  const { h, s, l } = hexToHsl(base)
  return `linear-gradient(100deg, ${hsl(h, s, Math.max(20, l - 9))} 0%, ${hsl(h, s, Math.max(24, l))} 54%, ${hsl(
    h,
    Math.min(100, s * 0.88),
    Math.max(26, l + 7)
  )} 100%)`
}
