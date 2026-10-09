/**
 * 书签链路自检（由 scripts/bookmarks-check.mjs 打包后运行）
 *
 * 覆盖：纯函数规则（位置匹配 / 摘录清洗 / 排序 / 分组）+ BookmarkStore 业务
 * （99 条上限、同位置去重、软删除与撤销、墓碑清理）+ 落盘与重启 + IPC 处理器链路。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOKMARK_LIMIT,
  activeBookmarks,
  bookmarkCount,
  bookmarkTimeText,
  findBookmarkAt,
  groupByBook,
  isExpiredTombstone,
  isSamePosition,
  lastBookmarkAt,
  normalizeExcerpt,
  normalizeNote,
  prunableTombstones,
  remainingBookmarkSlots,
  sortBookmarks,
  type Bookmark
} from '../src/shared/bookmarks'
import type { Book, Bookmark as BookmarkRecord } from '../src/shared/types'
import { BookmarkStore } from '../src/main/bookmarks'
import { registerIpc } from '../src/main/ipc'
import { Store } from '../src/main/store'
import { percentByPosition } from '../src/shared/progress'
import { hasHandler, invokeHandler } from './electron-stub'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

function make(over: Partial<Bookmark> = {}): Bookmark {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    bookId: 'book-a',
    chapterIndex: 1,
    chapterTitle: '第二章',
    scrollRatio: 0.5,
    percent: 0.2,
    excerpt: '他停下脚步，回头看那片褪色的樱花。',
    note: '',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deviceId: 'test-device',
    ...over
  }
}

/* ---------------- 1. 纯函数 ---------------- */

console.log('\n[1] 位置匹配与摘录清洗')
check('同章 + 比例差 0.01 → 同一处', isSamePosition(make({ scrollRatio: 0.5 }), make({ scrollRatio: 0.51 })))
check(
  '比例差 0.03 → 不是同一处',
  !isSamePosition(make({ scrollRatio: 0.5 }), make({ scrollRatio: 0.53 }))
)
check(
  '不同章 → 不是同一处',
  !isSamePosition(make({ chapterIndex: 1, scrollRatio: 0.5 }), make({ chapterIndex: 2, scrollRatio: 0.5 }))
)
check(
  '在列表里找得到同一处',
  findBookmarkAt([make({ id: 'x' })], 'book-a', { chapterIndex: 1, scrollRatio: 0.505 })?.id === 'x'
)
check(
  '别的书里找不到',
  findBookmarkAt([make({ id: 'x' })], 'book-b', { chapterIndex: 1, scrollRatio: 0.5 }) === null
)
check('换行与多余空白被压平', normalizeExcerpt('  他停下\n\n脚步  回头看 ') === '他停下 脚步 回头看')
check('句首孤立标点被去掉', normalizeExcerpt('，他停下脚步') === '他停下脚步')
check('摘录截断到 60 字', normalizeExcerpt('一'.repeat(120)).length === 60)
check('备注限长 300 字', normalizeNote('二'.repeat(400)).length === 300)

console.log('\n[2] 上限与计数')
const many = Array.from({ length: 5 }, (_, i) => make({ id: `m${i}`, scrollRatio: i / 10 }))
check('未删除计数', bookmarkCount(many, 'book-a') === 5, `${bookmarkCount(many, 'book-a')} 条`)
const freshTombstone = [...many, make({ id: 'just-deleted', deletedAt: Date.now() - 1000 })]
const oldTombstone = [...many, make({ id: 'long-gone', deletedAt: Date.now() - 3600 * 1000 })]
check('墓碑不计入未删除', activeBookmarks(freshTombstone).length === 5)
check('撤销窗口内的墓碑占额度', remainingBookmarkSlots(freshTombstone, 'book-a') === BOOKMARK_LIMIT - 6)
check('过了撤销窗口的墓碑不占额度', remainingBookmarkSlots(oldTombstone, 'book-a') === BOOKMARK_LIMIT - 5)
check('可清理的墓碑', prunableTombstones(oldTombstone).length === 1)

console.log('\n[3] 排序与分组')
const sa = make({ id: 'a', chapterIndex: 2, scrollRatio: 0.2, createdAt: 300 })
const sb = make({ id: 'b', chapterIndex: 1, scrollRatio: 0.9, createdAt: 100 })
const sc = make({ id: 'c', chapterIndex: 1, scrollRatio: 0.1, createdAt: 200 })
check(
  '最近添加：时间倒序',
  sortBookmarks([sb, sa, sc], 'recent').map((x) => x.id).join('') === 'acb'
)
check(
  '按章节：章号升序再按比例升序',
  sortBookmarks([sa, sb, sc], 'chapter').map((x) => x.id).join('') === 'cba'
)
check(
  '按书分组',
  groupByBook([sa, sb, make({ id: 'd', bookId: 'book-b' })], 'recent').size === 2
)
check('最近一条时间', lastBookmarkAt([sb, sc], 'book-a') === 200)
check(
  '过期墓碑判定（31 天前删的）',
  isExpiredTombstone(make({ deletedAt: Date.now() - 31 * 86400000 }))
)
check(
  '没过期的墓碑保留',
  !isExpiredTombstone(make({ deletedAt: Date.now() - 2 * 86400000 }))
)
check('时间显示：今天', /^今天 \d{2}:\d{2}$/.test(bookmarkTimeText(Date.now())))
check(
  '时间显示：昨天',
  /^昨天 \d{2}:\d{2}$/.test(bookmarkTimeText(Date.now() - 26 * 3600 * 1000))
)

/* ---------------- 4. BookmarkStore 业务 ---------------- */

console.log('\n[4] 增删改查与上限')
const bucket: BookmarkRecord[] = []
const store = new BookmarkStore(bucket)
const created = store.add(
  {
    bookId: 'book-a',
    chapterIndex: 3,
    chapterTitle: '第三章',
    scrollRatio: 0.4,
    percent: 0.25,
    excerpt: '，这一段的开头有标点'
  },
  'device-1'
)
check('新增成功', Boolean(created), created?.id ?? 'null')
check('摘录已清洗', created?.excerpt === '这一段的开头有标点', created?.excerpt ?? '')
check('设备号已写入', created?.deviceId === 'device-1')
check('备注初始为空', created?.note === '')
check(
  '同一位置再点不会重复',
  store.add(
    {
      bookId: 'book-a',
      chapterIndex: 3,
      chapterTitle: '第三章',
      scrollRatio: 0.405,
      percent: 0.25,
      excerpt: '同一处'
    },
    'device-1'
  ) === null
)
check('改备注', store.update(created!.id, { note: '这里是转折点' })?.note === '这里是转折点')
check('备注限长', store.update(created!.id, { note: '长'.repeat(400) })?.note.length === 300)
const moved = store.update(created!.id, { scrollRatio: 1.8 })
check('位置比例被夹到 0~1', moved?.scrollRatio === 1)

const quota: BookmarkRecord[] = []
const quotaStore = new BookmarkStore(quota)
for (let i = 0; i < BOOKMARK_LIMIT; i += 1) {
  quotaStore.add(
    {
      bookId: 'book-a',
      chapterIndex: i,
      chapterTitle: `第 ${i + 1} 章`,
      scrollRatio: 0.1,
      percent: 0.01 * i,
      excerpt: `第 ${i} 条`
    },
    'd'
  )
}
check(`加到 ${BOOKMARK_LIMIT} 条`, quota.length === BOOKMARK_LIMIT, `${quota.length} 条`)
check('第 100 条被拒绝', quotaStore.add(
  { bookId: 'book-a', chapterIndex: 999, chapterTitle: 'x', scrollRatio: 0, percent: 0, excerpt: 'x' },
  'd'
) === null)
check('别的书不受影响（按书计上限）', quotaStore.remaining('book-b') === BOOKMARK_LIMIT)
check('刚删除的墓碑仍占额度', (() => {
  const first = quota[0]
  quotaStore.remove(first.id)
  return quotaStore.remaining('book-a') === 0 && activeBookmarks(quota).length === BOOKMARK_LIMIT - 1
})())

console.log('\n[5] 软删除与撤销')
const target = quota[5]
const removed = quotaStore.remove(target.id)
check('删除返回墓碑', Boolean(removed?.deletedAt))
check('墓碑不在列表里', !quotaStore.list().some((item) => item.id === target.id))
check('刚删的墓碑仍占额度', quotaStore.remaining('book-a') === 0)
check('撤销成功', Boolean(quotaStore.restore(target.id)?.deletedAt === undefined))
check('撤销后回到列表', quotaStore.list().some((item) => item.id === target.id))
check('撤销后额度又被用掉', quotaStore.remaining('book-a') === 0)

// 再删一条并让撤销窗口过去：两条墓碑都该被清掉，额度回到 2
const other = quota[7]
check('删除另一条', Boolean(quotaStore.remove(other.id)?.deletedAt))
const pruned = quotaStore.pruneTombstones(Date.now() + 11 * 60 * 1000)
check('超过撤销窗口的墓碑可清理', pruned === 2, `清掉 ${pruned} 条`)
check('清理后腾出额度', quotaStore.remaining('book-a') === 2, `剩余 ${quotaStore.remaining('book-a')}`)
check('清理后能补回一条', Boolean(quotaStore.add(
  { bookId: 'book-a', chapterIndex: 500, chapterTitle: '第五百章', scrollRatio: 0.5, percent: 0.9, excerpt: '新的一条' },
  'd'
)))
check('补回后额度又用掉一个', quotaStore.remaining('book-a') === 1)

console.log('\n[6] 启动清理 sweep')
const dirty: BookmarkRecord[] = [
  make({ id: 'ok', scrollRatio: 0.5 }),
  make({ id: 'dup-new', scrollRatio: 0.51, updatedAt: 200 }),
  make({ id: 'dup-old', scrollRatio: 0.505, updatedAt: 100 }),
  make({ id: 'stale', deletedAt: Date.now() - 40 * 86400000 }),
  make({ id: 'bad-ratio', scrollRatio: 3 as number, percent: -1 as number })
]
const dirtyStore = new BookmarkStore(dirty)
const swept = dirtyStore.sweep()
check('sweep 报告有改动', swept)
check('同位置的旧数据被去掉', !dirty.some((item) => item.id === 'dup-old'), dirty.map((d) => d.id).join(','))
check('过期墓碑被清掉', !dirty.some((item) => item.id === 'stale'))
check('越界比例被修正', dirty.find((item) => item.id === 'bad-ratio')?.scrollRatio === 1)
check('非法进度被修正', dirty.find((item) => item.id === 'bad-ratio')?.percent === 0)
check('按书清除', new BookmarkStore([...dirty, make({ id: 'x', bookId: 'book-z' })]).removeByBook('book-z') === 1)

/* ---------------- 7. 落盘与重启 ---------------- */

console.log('\n[7] 落盘与重启')
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-bm-'))
const booksDir = join(dataDir, 'books')
process.env.DSH_DATA_DIR = dataDir
process.env.DSH_BOOKS_DIR = booksDir

try {
  const first = new Store(dataDir)
  await first.init()
  const book: Book = {
    id: 'book-a',
    title: '测试书 01',
    metaTitle: '测试书',
    author: '作者',
    format: 'epub',
    fileName: '测试书 01.epub',
    filePath: join(booksDir, 'book-a.epub'),
    fileSize: 1,
    contentHash: null,
    coverFile: null,
    coverColor: null,
    description: '',
    chapterCount: 3,
    chapterChars: [1000, 1000, 1000],
    wordCount: 3000,
    volume: '1',
    seriesKey: '测试书',
    manualSeries: null,
    addedAt: Date.now(),
    lastOpenedAt: null,
    hidden: false
  }
  first.books.push(book)
  first.save('library', true)

  const added = first.bookmarkStore.add(
    {
      bookId: 'book-a',
      chapterIndex: 1,
      chapterTitle: '第二章',
      scrollRatio: 0.5,
      percent: percentByPosition(book.chapterChars, book.wordCount, 1, 0.5),
      excerpt: '他停下脚步，回头看那片褪色的樱花，风把花瓣吹到他肩上。'
    },
    first.settings.deviceId
  )
  check('新增书签', Boolean(added) && first.bookmarks.length === 1)
  check(
    '整书进度按字数算（1/3 章 + 半章 = 0.5）',
    Math.abs((added?.percent ?? 0) - 0.5) < 1e-6,
    String(added?.percent)
  )

  await first.flushAll()
  const file = join(dataDir, 'bookmarks.json')
  check('bookmarks.json 已写出', existsSync(file))
  const raw = JSON.parse(readFileSync(file, 'utf8')) as BookmarkRecord[]
  check('落盘内容可解析且有 1 条', Array.isArray(raw) && raw.length === 1, `${raw.length} 条`)
  check(
    '落盘字段完整',
    ['id', 'bookId', 'chapterIndex', 'chapterTitle', 'scrollRatio', 'percent', 'excerpt', 'note', 'createdAt', 'updatedAt', 'deviceId'].every(
      (key) => key in (raw[0] as unknown as Record<string, unknown>)
    ),
    Object.keys(raw[0]).join(',')
  )

  const second = new Store(dataDir)
  await second.init()
  check('重启后书签还在', second.bookmarks.length === 1, `${second.bookmarks.length} 条`)
  check('重启后内容一致', second.bookmarks[0].excerpt === raw[0].excerpt)
  check('重启后设备号保留', second.bookmarks[0].deviceId === first.settings.deviceId)

  /* ---------------- 8. IPC 链路 ---------------- */

  console.log('\n[8] IPC 处理器链路')
  registerIpc(second)
  check('通道已注册', hasHandler('bookmarks:list') && hasHandler('bookmarks:add'))
  check('list 返回重启后的书签', (await invokeHandler('bookmarks:list')).length === 1)
  check('remaining 反映剩余额度', (await invokeHandler('bookmarks:remaining', 'book-a')) === BOOKMARK_LIMIT - 1)

  const viaIpc = await invokeHandler('bookmarks:add', {
    bookId: 'book-a',
    chapterIndex: 2,
    chapterTitle: '第三章',
    scrollRatio: 0.25,
    percent: 0,
    excerpt: '第三章的第一段。'
  })
  check('通过 IPC 新增成功', Boolean(viaIpc?.id))
  check(
    '整书进度由主进程重算（2/3 章 + 0.25 章 = 0.75）',
    Math.abs((viaIpc?.percent ?? 0) - 0.75) < 1e-6,
    String(viaIpc?.percent)
  )

  const ipcRemoved = await invokeHandler('bookmarks:remove', viaIpc.id)
  check('通过 IPC 删除（软删除）', Boolean(ipcRemoved?.deletedAt))
  check('删除后列表少一条', (await invokeHandler('bookmarks:list')).length === 1)
  check('通过 IPC 撤销', Boolean((await invokeHandler('bookmarks:restore', viaIpc.id))?.id))
  check('撤销后列表回到 2 条', (await invokeHandler('bookmarks:list')).length === 2)
  check('按章排序可用', (await invokeHandler('bookmarks:list', 'book-a', 'chapter'))[0].chapterIndex === 1)
  check('不存在的书加不了', (await invokeHandler('bookmarks:add', {
    bookId: 'nope',
    chapterIndex: 0,
    chapterTitle: '',
    scrollRatio: 0,
    percent: 0,
    excerpt: ''
  })) === null)
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n共 ${checks} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('❌ 书签自检未通过')
  process.exit(1)
}
console.log('✅ 书签自检全部通过')
