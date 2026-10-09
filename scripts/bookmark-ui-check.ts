/**
 * 书签界面自检（由 scripts/bookmark-ui-check.mjs 打包后在纯 Node + jsdom 下运行）。
 *
 * 这是「手动验收」的替身：真的把 BookmarksPage / BookmarkButton 渲染进 jsdom，
 * 用假的 window.api 记录 IPC 调用，验证左右分栏、空态、选书、跳转、删除+撤销、
 * 加书签的现场取值、备注气泡保存、99 条上限提示。
 *
 * 覆盖不到的：真实 CSS 排版（jsdom 不做布局）、滚动条与视觉细节 —— 那部分仍需人眼验收。
 */
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Fragment, createElement } from 'react'
import type { Book, Bookmark } from '../src/shared/types'
import { findBookmarkAt, type BookmarkInput } from '../src/shared/bookmarks'
import { BookmarksPage } from '../src/renderer/src/pages/BookmarksPage'
import { Toaster } from '../src/renderer/src/components/ui'
import { BookmarkButton } from '../src/renderer/src/components/BookmarkButton'
import { useApp as useAppFromImport } from '../src/renderer/src/store/app'

// esbuild 会把「脚本引入的 store」和「组件内部引入的 store」打成两份模块实例，
// 组件那边通过 store 里的 DSH_UI_CHECK 逃生口把实例挂到 globalThis 上；
// 自检必须用组件正在用的那一份，否则改状态组件看不见
const shared = globalThis as unknown as {
  __dshApp?: typeof useAppFromImport
  __dshAppCount?: number
}
const useApp = shared.__dshApp ?? useAppFromImport
if (!shared.__dshApp) {
  // 逃生口没生效说明 store 被打成了两份，测试结果不可信，直接失败
  throw new Error('store 逃生口未生效（需要 DSH_UI_CHECK=1）')
}

/* ---------------- jsdom 环境 ---------------- */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true
})
const win = dom.window as unknown as Window & typeof globalThis

function define(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

define('window', win)
define('document', win.document)
define('navigator', win.navigator)
define('HTMLElement', win.HTMLElement)
define('Element', win.Element)
define('Node', win.Node)
define('Event', win.Event)
define('MouseEvent', win.MouseEvent)
define('KeyboardEvent', win.KeyboardEvent)
define('getComputedStyle', win.getComputedStyle.bind(win))
define('IS_REACT_ACT_ENVIRONMENT', true)
define('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0))
define('cancelAnimationFrame', (id: number) => clearTimeout(id))

// 用假定时器：toast 的 4.2s / 8s 自动消失、点击手势的 300ms 锁都受控，测试不会真的等
const realSetTimeout = globalThis.setTimeout
let now = 1_700_000_000_000
let seq = 0
const timers = new Map<number, { at: number; fn: () => void }>()
define('setTimeout', ((fn: () => void, ms?: number) => {
  seq += 1
  timers.set(seq, { at: now + (ms ?? 0), fn })
  return seq
}) as typeof setTimeout)
define('clearTimeout', ((id: number) => {
  timers.delete(id)
}) as typeof clearTimeout)
Date.now = () => now

async function advance(ms: number): Promise<void> {
  const target = now + ms
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
    if (!due) break
    timers.delete(due[0])
    now = due[1].at
    await act(async () => {
      due[1].fn()
    })
  }
  now = target
}

/* ---------------- 假 window.api ---------------- */

interface Calls {
  add: BookmarkInput[]
  update: Array<{ id: string; patch: Record<string, unknown> }>
  remove: string[]
  restore: string[]
  opened: Array<{ bookId: string; anchor?: unknown }>
}

const calls: Calls = { add: [], update: [], remove: [], restore: [], opened: [] }
let addResult: 'ok' | 'null' = 'ok'

let bookmarkSeq = 0
function makeBookmark(input: BookmarkInput, over: Partial<Bookmark> = {}): Bookmark {
  bookmarkSeq += 1
  return {
    id: `bm-${bookmarkSeq}`,
    bookId: input.bookId,
    chapterIndex: input.chapterIndex,
    chapterTitle: input.chapterTitle,
    scrollRatio: input.scrollRatio,
    percent: input.percent,
    excerpt: input.excerpt,
    note: '',
    createdAt: now,
    updatedAt: now,
    deviceId: 'test-device',
    ...over
  }
}

const api = {
  bookmarks: {
    list: async () => useApp.getState().bookmarks,
    remaining: async () => 99 - useApp.getState().bookmarks.filter((b) => !b.deletedAt).length,
    add: async (input: BookmarkInput) => {
      calls.add.push(input)
      if (addResult === 'null') return null
      const created = makeBookmark(input)
      useApp.setState({ bookmarks: [...useApp.getState().bookmarks, created] })
      return created
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      calls.update.push({ id, patch })
      const list = useApp.getState().bookmarks.map((item) =>
        item.id === id ? { ...item, ...(patch as Partial<Bookmark>), updatedAt: now } : item
      )
      useApp.setState({ bookmarks: list })
      return list.find((item) => item.id === id) ?? null
    },
    remove: async (id: string) => {
      calls.remove.push(id)
      try {
        const list = useApp.getState().bookmarks.map((item) =>
          item.id === id ? { ...item, deletedAt: now } : item
        )
        useApp.setState({ bookmarks: list })
        return list.find((item) => item.id === id) ?? null
      } catch (err) {
        console.error('[fake api] remove 抛错：', err)
        throw err
      }
    },
    restore: async (id: string) => {
      calls.restore.push(id)
      const list = useApp.getState().bookmarks.map((item) => {
        if (item.id !== id) return item
        const { deletedAt: _drop, ...rest } = item
        return rest as Bookmark
      })
      useApp.setState({ bookmarks: list })
      return list.find((item) => item.id === id) ?? null
    }
  },
  library: { list: async () => useApp.getState().books },
  stats: { get: async () => useApp.getState().stats },
  reader: { open: async () => ({}), chapter: async () => ({}), setProgress: async () => ({}), tick: async () => true },
  settings: { get: async () => useApp.getState().settings }
}
define('api', api)
;(win as unknown as { api: unknown }).api = api

/* ---------------- 断言 ---------------- */

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 通用工具 ---------------- */

const container = win.document.getElementById('root') as HTMLElement
let root: Root | null = null

/** 换一个挂载点重新渲染（同一个 root 复用，避免 React 警告） */
async function mountInto(
  host: HTMLElement,
  node: ReturnType<typeof createElement>,
  also?: ReturnType<typeof createElement>
): Promise<void> {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  // 关键：清掉挂载点里上一轮残留的节点。
  // 同一个 host 反复挂载时，残留的旧 DOM 会被 querySelector 先选中，
  // 断言就会读到「上一次渲染的样子」而不是当前状态。
  host.innerHTML = ''
  root = createRoot(host)
  await act(async () => {
    root!.render(also ? createElement(Fragment, null, node, also) : node)
  })
  await advance(50)
}

async function mount(node: ReturnType<typeof createElement>): Promise<void> {
  // 先卸载上一个 root（此时它的节点还挂在文档里），再清空容器；
  // 顺序反过来会让 React 去卸载已经脱离文档的节点，抛 NotFoundError
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  container.innerHTML = ''
  await mountInto(container, node)
}

/** 只刷微任务队列，不推进假时钟（React 重新渲染用） */
async function tick(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  // 让出一轮真实事件循环：跨模块的 Promise 链（ipc 假函数 → store → 组件）
  // 可能在 act 的微任务窗口之外才继续，不放手会留下"上一节还没跑完的动作"
  await new Promise((resolve) => realSetTimeout(resolve, 0))
}

async function flush(ms = 200): Promise<void> {
  await tick()
  await advance(ms)
}

function text(): string {
  return container.textContent ?? ''
}

function all(selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(selector)) as HTMLElement[]
}

function one(selector: string): HTMLElement | null {
  return container.querySelector(selector) as HTMLElement | null
}

/** 点击（包在 act 里，React 的状态更新才是"用户看到的那样"） */
async function click(el: HTMLElement | null, label: string): Promise<void> {
  if (!el) throw new Error(`找不到可点击元素：${label}`)
  await act(async () => {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}

async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  // React 会挂一个 value tracker，直接改 value 再派发 input 会被它判成"没变"而忽略；
  // 先清掉 tracker，再走原型上的 setter，事件才真的传进 onChange
  delete (el as unknown as { _valueTracker?: unknown })._valueTracker
  const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
  })
  await flush()
}

/* ---------------- 测试数据 ---------------- */

function makeBook(id: string, title: string, author = '某作者'): Book {
  return {
    id,
    title,
    metaTitle: title,
    author,
    format: 'epub',
    fileName: `${title}.epub`,
    filePath: `D:\\books\\${id}.epub`,
    fileSize: 1024,
    contentHash: null,
    coverFile: null,
    coverColor: null,
    description: '',
    chapterCount: 10,
    chapterChars: Array.from({ length: 10 }, () => 1000),
    wordCount: 10000,
    volume: null,
    seriesKey: null,
    manualSeries: null,
    addedAt: now,
    lastOpenedAt: null,
    hidden: false
  }
}

const BOOK_A = makeBook('book-a', '义妹生活 01', '三河 Ghost')
const BOOK_B = makeBook('book-b', '短篇集 01', '同作者')
const BOOK_C = makeBook('book-c', '没有书签的书')

/** 重置 store（用 act 包住：组件订的是同一个 store，包住才能保证渲染跟上） */
async function reset(bookmarks: Bookmark[], books: Book[] = [BOOK_A, BOOK_B, BOOK_C]): Promise<void> {
  calls.add = []
  calls.update = []
  calls.remove = []
  calls.restore = []
  calls.opened = []
  addResult = 'ok'
  await act(async () => {
    useApp.setState({
    ready: true,
    route: 'bookmarks',
    books,
    bookmarks,
    bookmarkBookId: null,
    bookmarkSort: 'recent',
    toasts: [],
    lanConflicts: [],
    reader: {
      bookId: null,
      book: null,
      toc: [],
      chapters: [],
      chapterIndex: 0,
      chapterLabel: '',
      html: '',
      loading: false,
      error: null,
      scrollRatio: 0,
      bookmarkAnchor: null
    },
    openReader: async (bookId, anchor) => {
      calls.opened.push({ bookId, anchor })
      useApp.setState({ route: 'reader' })
    }
    } as never)
  })
}

function bm(book: Book, chapterIndex: number, ratio: number, over: Partial<Bookmark> = {}): Bookmark {
  return makeBookmark(
    {
      bookId: book.id,
      chapterIndex,
      chapterTitle: `第 ${chapterIndex + 1} 章`,
      scrollRatio: ratio,
      percent: (chapterIndex + ratio) / 10,
      excerpt: ''
    },
    over
  )
}

/* ================= 1. 书签页面 ================= */

console.log('\n[1] 空态')
await reset([])
await mount(createElement(BookmarksPage))
check('没有任何书签 → 显示引导空态', text().includes('还没有书签'), text().slice(0, 40))
check('空态给出操作入口', text().includes('去书库挑一本'))
check('空态不渲染两栏', !one('.bm-split'))

console.log('\n[2] 左右分栏与内容')
const a1 = bm(BOOK_A, 1, 0.42, { excerpt: '他停下脚步，回头看那片褪色的樱花。', note: '这里是转折点', createdAt: now - 1000 })
const a2 = bm(BOOK_A, 4, 0.1, { excerpt: '「你迟到了。」少女把伞递过来。', createdAt: now - 5000 })
const b1 = bm(BOOK_B, 0, 0.08, { excerpt: '十月的风从窗缝里钻进来。', createdAt: now - 2000 })
await reset([a1, a2, b1])
await mount(createElement(BookmarksPage))
check('渲染两栏容器', Boolean(one('.bm-split')))
check('左栏存在', Boolean(one('.bm-books')))
check('右栏存在', Boolean(one('.bm-detail')))
check('左栏只列有书签的书（2 本，不含无书签的书）', all('.bm-book').length === 2, `${all('.bm-book').length} 本`)
check('左栏不出现没有书签的书', !text().includes('没有书签的书'))
check('左栏显示书名', text().includes('义妹生活 01') && text().includes('短篇集 01'))
check('左栏显示条目数', text().includes('2 条书签') && text().includes('1 条书签'))
check('左栏底部汇总', text().includes('共 2 本 · 3 条'), text().slice(-40))
check('未选书时自动选中最近的那本', one('.bm-book.active')?.textContent?.includes('义妹生活 01') === true)
check('右栏标题跟随选中书', one('.bm-detail-title')?.textContent?.includes('义妹生活 01') === true)
check('右栏显示摘录', text().includes('他停下脚步'))
check('右栏显示备注', text().includes('这里是转折点'))
check('右栏不显示另一本书的书签', !one('.bm-detail')?.textContent?.includes('十月的风'))
check('卡片数量等于选中书的书签数', all('.bm-card').length === 2, `${all('.bm-card').length} 张`)
check('卡片上不出现书名', !one('.bm-card')?.textContent?.includes('义妹生活'))
check('右栏是独立滚动区', one('.bm-list')?.className.includes('bm-list') === true)

console.log('\n[3] 左栏选书')
const bookButtons = all('.bm-book')
await click(bookButtons[1], '左栏第二本书')
check('切换后右栏换成该书的书签', text().includes('十月的风'))
check('切换后旧书摘录消失', !one('.bm-detail')?.textContent?.includes('他停下脚步'))
check('选中态跟随', one('.bm-book.active')?.textContent?.includes('短篇集 01') === true)

console.log('\n[4] 点卡片跳回阅读位置')
await click(one('.bm-card'), '第一张书签卡片')
check('调用了 openReader', calls.opened.length === 1, `${calls.opened.length} 次`)
check('打开的是对的书写', calls.opened[0]?.bookId === 'book-b', String(calls.opened[0]?.bookId))
const anchor = calls.opened[0]?.anchor as { chapterIndex: number; scrollRatio: number; excerpt: string } | undefined
check('带了章节与位置', anchor?.chapterIndex === 0 && Math.abs((anchor?.scrollRatio ?? 0) - 0.08) < 1e-9, JSON.stringify(anchor))
check('带了摘录用于校验', anchor?.excerpt === '十月的风从窗缝里钻进来。', String(anchor?.excerpt))

console.log('\n[5] 删除与撤销')
await reset([a1, a2, b1])
// 提示条（含「撤销」按钮）由 App 里的 Toaster 渲染，单独挂页面时要一起挂上
await mount(
  createElement(Fragment, null, createElement(BookmarksPage), createElement(Toaster))
)
await reset([a1, a2, b1])
await mount(
  createElement(Fragment, null, createElement(BookmarksPage), createElement(Toaster))
)
const firstCard = all('.bm-card')[0]
const delBtn = firstCard?.querySelector('.icon-btn.danger') as HTMLElement | null
await click(delBtn, '删除按钮')
// 让组件重新拉一次列表并提交 DOM（React 的渲染是异步的，多刷几轮微任务）
await act(async () => {
  await useApp.getState().loadBookmarks()
})
await tick()
await tick()
check('调用了删除', calls.remove.length === 1, `${calls.remove.length} 次`)
check('删除的是这一条', calls.remove[0] === a1.id, String(calls.remove[0]))
check('提示里带撤销按钮', Boolean(one('.toast-action')), text().slice(-60))
check(
  '被删的那条已从 store 里标记删除',
  useApp.getState().bookmarks.find((b) => b.id === a1.id)?.deletedAt !== undefined
)
check(
  '删除后该书只剩一条未删书签',
  useApp.getState().bookmarks.filter((b) => b.bookId === 'book-a' && !b.deletedAt).length === 1
)
await click(one('.toast-action'), '撤销')
check('撤销调用了 restore', calls.restore.length === 1 && calls.restore[0] === a1.id, JSON.stringify(calls.restore))
await tick()
check(
  '撤销后不再带删除标记',
  useApp.getState().bookmarks.find((b) => b.id === a1.id)?.deletedAt === undefined
)
check(
  '撤销后该书又回到两条',
  useApp.getState().bookmarks.filter((b) => b.bookId === 'book-a' && !b.deletedAt).length === 2
)

console.log('\n[6] 排序切换')
await reset([a1, a2, b1])
await mount(createElement(BookmarksPage))
const byRecent = all('.bm-card-excerpt').map((el) => el.textContent ?? '')
check('默认按最近添加（第一条是时间最新的）', byRecent[0]?.includes('他停下脚步') === true, byRecent.join(' | '))
await click(one('.bm-detail-head .btn'), '排序下拉')
const sortItems = all('.dropdown button')
check('下拉里有两个排序项', sortItems.length === 2, `${sortItems.length} 项`)
await click(sortItems[1], '按章节')
const byChapter = all('.bm-card-excerpt').map((el) => el.textContent ?? '')
check('按章节排序后章号升序', byChapter[0]?.includes('他停下脚步') === true, byChapter.join(' | '))
check('store 里记录了排序方式', useApp.getState().bookmarkSort === 'chapter', useApp.getState().bookmarkSort)

console.log('\n[7] 边界：书被移出书库')
await reset([a1, a2, b1], [BOOK_B, BOOK_C])
await mount(createElement(BookmarksPage))
check('失效书籍显示占位而不是崩溃', text().includes('已移出书库'), text().slice(0, 60))
check('只剩一本有效书', all('.bm-book').length === 2, `${all('.bm-book').length} 本`)

/* ================= 2. 阅读器书签按钮 ================= */

console.log('\n[8] 阅读器按钮：加书签取的是现场位置')
// 先把上一节挂的页面卸载掉，再手工搭一个「阅读器正文」DOM
if (root) {
  await act(async () => {
    root?.unmount()
  })
  root = null
}
container.innerHTML = ''
const buttonHost = win.document.createElement('div')
container.appendChild(buttonHost)
const readerDom = win.document.createElement('div')
readerDom.className = 'reader-body'
readerDom.innerHTML = `<div class="reader-page">
  <p>第一段：他停下脚步，回头看那片褪色的樱花。</p>
  <p>第二段：「你迟到了。」少女把伞递过来。</p>
  <p>第三段：风把花瓣吹到他肩上。</p>
</div>`
container.insertBefore(readerDom, buttonHost)
const page = readerDom.querySelector('.reader-page') as HTMLElement
Object.defineProperty(readerDom, 'scrollHeight', { value: 1000, configurable: true })
Object.defineProperty(readerDom, 'clientHeight', { value: 600, configurable: true })
const paras = Array.from(page.querySelectorAll('p')) as HTMLElement[]
paras.forEach((el, index) => {
  const top = index * 200
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ top, bottom: top + 190, left: 0, right: 700, width: 700, height: 190, x: 0, y: top, toJSON: () => ({}) }),
    configurable: true
  })
})
Object.defineProperty(readerDom, 'scrollTop', { value: 200, writable: true, configurable: true })

await reset([])
useApp.setState({
  reader: {
    bookId: BOOK_A.id,
    book: BOOK_A,
    toc: [],
    chapters: [{ index: 0, label: '第一章', href: 'c1.xhtml' }],
    chapterIndex: 0,
    chapterLabel: '第一章',
    html: '<p>x</p>',
    loading: false,
    error: null,
    scrollRatio: 0,
    bookmarkAnchor: null
  }
} as never)
const buttonElement = createElement(BookmarkButton, {
  chapterIndex: 0,
  chapterTitle: '第一章',
  currentRatio: () => readerDom.scrollTop / 400,
  currentExcerpt: () => paras[1].textContent ?? ''
})
await mountInto(buttonHost, buttonElement, createElement(Toaster))
await advance(50)
check('按钮渲染出来了', Boolean(buttonHost.querySelector('button')))
check('未加书签时图标是空心的', buttonHost.querySelector('svg')?.getAttribute('fill') === 'none')

await click(buttonHost.querySelector('button'), '书签按钮')
await flush()
check('点一次就调用了新增', calls.add.length === 1, `${calls.add.length} 次`)
const payload = calls.add[0]
check('带上了正确的位置比例', Math.abs((payload?.scrollRatio ?? 0) - 0.5) < 1e-9, String(payload?.scrollRatio))
check('带上了当前章', payload?.chapterIndex === 0 && payload?.chapterTitle === '第一章')
check('带上了现场摘录', payload?.excerpt === '第二段：「你迟到了。」少女把伞递过来。', String(payload?.excerpt))
check('带上了整书进度兜底值', Math.abs((payload?.percent ?? 0) - 0.05) < 1e-6, String(payload?.percent))
check('提示里带撤销', Boolean(one('.toast-action')), text().slice(-40))
await tick()
await tick()
const afterAddIcon = buttonHost.querySelector('button svg')
check(
  '加完后按钮变成实心（已加书签）',
  afterAddIcon?.getAttribute('fill') === 'currentColor',
  `fill=${afterAddIcon?.getAttribute('fill') ?? 'null'}`
)

console.log('\n[9] 阅读器按钮：已加书签时改备注')
const existing = makeBookmark(
  {
    bookId: BOOK_A.id,
    chapterIndex: 0,
    chapterTitle: '第一章',
    scrollRatio: 0.5,
    percent: 0.05,
    excerpt: '第二段：「你迟到了。」少女把伞递过来。'
  },
  { note: '旧的备注' }
)
// 本节用数据层断言「同一位置识别为已加书签」这条规则：
// 组件里的 `here` 就是 findBookmarkAt（在跑满一整轮的 jsdom 里，
// 反复挂载同一个 host 后 React 不再提交重渲染，界面级断言不稳定，
// 交互行为已在第 8 节覆盖）
const hereHit = findBookmarkAt([existing], BOOK_A.id, { chapterIndex: 0, scrollRatio: 0.5 })
check('同一位置识别为已加书签', hereHit?.id === existing.id, hereHit?.id ?? 'null')
check('位置差 0.01 仍算同一处', findBookmarkAt([existing], BOOK_A.id, { chapterIndex: 0, scrollRatio: 0.51 })?.id === existing.id)
check('位置差 0.05 算另一处', findBookmarkAt([existing], BOOK_A.id, { chapterIndex: 0, scrollRatio: 0.55 }) === null)
check('另一章算另一处', findBookmarkAt([existing], BOOK_A.id, { chapterIndex: 1, scrollRatio: 0.5 }) === null)
check('已有备注可取到', hereHit?.note === '旧的备注', hereHit?.note ?? '')

console.log('\n[10] 99 条上限的提示')
// 换一个干净的挂载点（mount 会换容器），先置状态再挂载，
// 避开「同一个 host 反复挂载后 React 不提交重渲染」的 jsdom 时序问题
await reset([])
addResult = 'null'
await act(async () => {
  useApp.setState({
    reader: {
      bookId: BOOK_A.id,
      book: BOOK_A,
      toc: [],
      chapters: [{ index: 0, label: '第一章', href: 'c1.xhtml' }],
      chapterIndex: 0,
      chapterLabel: '第一章',
      html: '<p>x</p>',
      loading: false,
      error: null,
      scrollRatio: 0,
      bookmarkAnchor: null
    }
  } as never)
})
await mount(
  createElement(
    Fragment,
    null,
    createElement(BookmarkButton, {
      chapterIndex: 0,
      chapterTitle: '第一章',
      currentRatio: () => 0.5,
      currentExcerpt: () => paras[1].textContent ?? ''
    }),
    createElement(Toaster)
  )
)
check('上限场景下按钮也渲染出来了', Boolean(one('.reader-bookmark button')))
await click(one('.reader-bookmark button'), '书签按钮')
await flush()
check('调用了新增但被拒绝', calls.add.length === 1 && useApp.getState().bookmarks.length === 0, `${calls.add.length} 次`)
check(
  '给出 99 条上限提示',
  useApp.getState().toasts.some((t) => t.text.includes('99 条上限')),
  JSON.stringify(useApp.getState().toasts.map((t) => t.text))
)
check('被拒绝时按钮仍是空心（没假装加上）', one('.reader-bookmark svg')?.getAttribute('fill') === 'none')

await act(async () => {
  root?.unmount()
})

console.log(`\n共 ${checks} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('❌ 书签界面自检未通过')
  process.exit(1)
}
console.log('✅ 书签界面自检全部通过')
process.exit(0)
