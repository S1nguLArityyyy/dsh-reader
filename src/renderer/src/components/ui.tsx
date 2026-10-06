import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useApp } from '../store/app'

/* ---------------- 弹窗 ---------------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
  titleExtra
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  titleExtra?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">
            {title}
            {titleExtra}
          </div>
          <button className="icon-btn sm" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/* ---------------- 环形进度 ---------------- */

export function ProgressRing({
  percent,
  size = 128,
  stroke = 11,
  children
}: {
  percent: number
  size?: number
  stroke?: number
  children?: ReactNode
}) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const value = Math.min(1, Math.max(0, percent))
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset .45s ease' }}
        />
      </svg>
      <div className="ring-content">{children}</div>
    </div>
  )
}

/* ---------------- 分段控件 ---------------- */

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size,
  variant = 'solid'
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  size?: 'sm'
  variant?: 'solid' | 'soft'
}) {
  return (
    <div className={`segmented${size === 'sm' ? ' sm' : ''}${variant === 'soft' ? ' soft' : ''}`}>
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ---------------- 开关 / 滑块 ---------------- */

export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <i />
    </button>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <input
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

/* ---------------- 下拉菜单 ---------------- */

export function Dropdown({
  trigger,
  children,
  align = 'right'
}: {
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  align?: 'right' | 'left'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="dropdown-wrap" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open ? (
        <div className="dropdown" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- 空状态 ---------------- */

export function EmptyState({
  icon,
  title,
  desc,
  action
}: {
  icon: ReactNode
  title: string
  desc?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {desc ? <div className="empty-desc">{desc}</div> : null}
      {action ? <div style={{ marginTop: 10 }}>{action}</div> : null}
    </div>
  )
}

/* ---------------- 轻提示 ---------------- */

export function Toaster() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => dismiss(toast.id)}>
          {toast.kind === 'error' ? (
            <AlertCircle size={16} />
          ) : toast.kind === 'success' ? (
            <CheckCircle2 size={16} />
          ) : (
            <Info size={16} />
          )}
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  )
}
