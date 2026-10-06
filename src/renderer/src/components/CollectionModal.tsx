import { useState } from 'react'
import { FolderPlus, Layers } from 'lucide-react'
import { useApp } from '../store/app'
import { allSeriesNames } from '../lib/library'
import { Modal } from './ui'

/** 「归入合集」弹窗：手动把书归到某个合集，或新建一个合集名 */
export function CollectionModal({
  bookIds,
  onClose
}: {
  bookIds: string[] | null
  onClose: () => void
}) {
  const books = useApp((s) => s.books)
  const setManualSeries = useApp((s) => s.setManualSeries)
  const [name, setName] = useState('')

  const open = Boolean(bookIds && bookIds.length > 0)
  const names = allSeriesNames(books)
  const current = bookIds && bookIds.length === 1 ? books.find((b) => b.id === bookIds[0])?.manualSeries : null

  const apply = async (value: string | null): Promise<void> => {
    if (!bookIds) return
    await setManualSeries(bookIds, value)
    setName('')
    onClose()
  }

  return (
    <Modal
      open={open}
      title={`归入合集（${bookIds?.length ?? 0} 本）`}
      onClose={onClose}
      width={520}
      variant="sheet"
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => void apply(null)} disabled={!current}>
            移出合集
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void apply(name.trim())} disabled={!name.trim()}>
            确定
          </button>
        </>
      }
    >
      <div className="setting-hint" style={{ marginBottom: 12 }}>
        合集名会覆盖自动识别的系列，方便整理文件名里没有卷号的书。已有合集可以直接点选。
      </div>

      <input
        className="input"
        style={{ width: '100%' }}
        placeholder="输入合集名，例如：败北女角太多了"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) void apply(name.trim())
        }}
      />

      {names.length > 0 ? (
        <>
          <div className="setting-label" style={{ marginTop: 16, marginBottom: 8 }}>
            已有合集
          </div>
          <div className="collection-list">
            {names.map((item) => (
              <button key={item} className="collection-chip" onClick={() => setName(item)}>
                <Layers size={13} />
                {item}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="setting-hint" style={{ marginTop: 16 }}>
          <FolderPlus size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          还没有任何合集，输入名字即可创建。
        </div>
      )}
    </Modal>
  )
}
