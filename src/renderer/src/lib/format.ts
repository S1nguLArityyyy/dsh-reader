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
  return durationParts(seconds)
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
