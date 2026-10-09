import type { ReactNode } from 'react'
import { AlertTriangle, Smartphone, Monitor } from 'lucide-react'
import { useApp } from '../store/app'
import { Modal } from './ui'
import { formatDateTime, percentText } from '../lib/format'

/** 一侧的选项按钮：显示进度、时间与章节名 */
function Side({
  active,
  icon,
  label,
  percent,
  at,
  chapter,
  onClick
}: {
  active: boolean
  icon: ReactNode
  label: string
  percent: number
  at: number
  chapter: string
  onClick: () => void
}) {
  return (
    <button className={`conflict-opt${active ? ' active' : ''}`} onClick={onClick}>
      <b>
        {icon}
        {label}
      </b>
      <small>
        进度 {percentText(percent)}%
        <br />
        {formatDateTime(at)}
        <br />
        {chapter || '（无章节名）'}
      </small>
    </button>
  )
}

/**
 * 手机的阅读进度与电脑端冲突时的裁决弹窗。
 *
 * 触发条件（主进程判定）：手机推来的这份比电脑端新，且电脑端在手机上次推送之后也动过这本书。
 * 手机推来的整批记录此时**没有落盘**，等这里选完才合并。
 */
export function LanConflictModal() {
  const open = useApp((s) => s.lanConflictOpen)
  const conflicts = useApp((s) => s.lanConflicts)
  const choices = useApp((s) => s.lanChoices)
  const setOpen = useApp((s) => s.setLanConflictOpen)
  const choose = useApp((s) => s.chooseLanConflict)
  const chooseAll = useApp((s) => s.chooseAllLanConflicts)
  const resolve = useApp((s) => s.resolveLanConflicts)

  return (
    <Modal
      open={open}
      title="手机与电脑的进度冲突"
      onClose={() => setOpen(false)}
      width={640}
      titleExtra={
        <span className="conflict-preview-badge">
          <AlertTriangle size={12} />
          待裁决 {conflicts.length} 本
        </span>
      }
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => chooseAll('desktop')}>
            全部用电脑的
          </button>
          <button className="btn btn-ghost" onClick={() => chooseAll('phone')}>
            全部用手机的
          </button>
          <div className="reader-spacer" style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={() => void resolve()}>
            确认并合并
          </button>
        </>
      }
    >
      <p className="conflict-desc">
        这些书在手机和电脑上都读过、且两边进度不同。手机推来的记录<b>还没有写入</b>，
        你选哪一边就用哪一边；没单独改动的按较新的那份处理。
      </p>

      {conflicts.map((item) => (
        <div className="conflict-item" key={item.bookId}>
          <div className="conflict-title">{item.title}</div>
          <div className="conflict-options">
            <Side
              active={choices[item.bookId] === 'phone'}
              icon={<Smartphone size={13} style={{ verticalAlign: -2, marginRight: 4 }} />}
              label="用手机的"
              percent={item.phonePercent}
              at={item.phoneAt}
              chapter={item.phoneChapterTitle}
              onClick={() => choose(item.bookId, 'phone')}
            />
            <Side
              active={choices[item.bookId] === 'desktop'}
              icon={<Monitor size={13} style={{ verticalAlign: -2, marginRight: 4 }} />}
              label="用电脑的"
              percent={item.desktopPercent}
              at={item.desktopAt}
              chapter={item.desktopChapterTitle}
              onClick={() => choose(item.bookId, 'desktop')}
            />
          </div>
        </div>
      ))}

      {conflicts.length === 0 ? <div className="setting-hint">当前没有待裁决的冲突。</div> : null}
    </Modal>
  )
}
