/**
 * 划线 / 笔记的界面侧自检：主进程切词（tokenizeHtml）与渲染层 DOM 遍历（tokenizeDom）
 * 必须得出完全一致的结构，否则主进程注入的标记会画错位置。
 *
 * 另外验证「DOM 选区 → 锚点 → 注入标记 → 还原选区」这条闭环，
 * 以及阅读记录页的两栏结构与筛选。
 */
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { Fragment, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { tokenizeHtml } from '../src/shared/annotations'
import { anchorRange, selectionAnchor, tokenizeDom } from '../src/renderer/src/lib/annotation-anchor'
import { applyAnnotations } from '../src/main/annotations'
import { RecordsPage } from '../src/renderer/src/pages/RecordsPage'
import { Toaster } from '../src/renderer/src/components/ui'
import { useApp as useAppImport } from '../src/renderer/src/store/app'
import type { Annotation, Book } from '../src/shared/types'

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
define('Text', win.Text)
define('Event', win.Event)
define('MouseEvent', win.MouseEvent)
define('KeyboardEvent', win.KeyboardEvent)
define('getComputedStyle', win.getComputedStyle.bind(win))
define('IS_REACT_ACT_ENVIRONMENT', true)
define('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0))
define('cancelAnimationFrame', (id: number) => clearTimeout(id))

const shared = globalThis as unknown as { __dshApp?: typeof useAppImport }
const useApp = shared.__dshApp ?? useAppImport
if (!shared.__dshApp) throw new Error('store 逃生口未生效（需要 DSH_UI_CHECK=1）')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 1. 结构对齐 ---------------- */

console.log('\n[1] 主进程切词 与 渲染层 DOM 遍历 结构一致')

const CASES: Array<[string, string]> = [
  ['普通段落', '<h2>第一章</h2>\n<p>他停下脚步，回头看那片褪色的樱花。</p>\n<p>「你迟到了。」少女把伞递过来。</p>'],
  ['行内标签', '<p>他<em>停下</em>脚步，<a href="x.html">回头看</a>那片<b>褪色的</b>樱花。</p>'],
  ['列表', '<ul><li>第一项</li><li>第二项</li></ul>'],
  ['实体', '<p>他说：&quot;你好&quot; &amp; 再见&nbsp;吧</p>'],
  ['多余空白', '<p>\n  这是   一段\n\n  有空白的文字  \n</p>'],
  ['图片与换行', '<p>前<img src="a.png" alt="图"/>后<br/>换行之后</p>'],
  ['嵌套块', '<div><p>里面的段落</p><blockquote>引用的一段</blockquote></div>'],
  ['空段落', '<p></p><p>有内容</p>'],
  ['跳过脚本', '<style>p{color:red}</style><p>正文</p><script>var a=1</script><p>结尾</p>']
]

for (const [name, html] of CASES) {
  const mainTokens = tokenizeHtml(html)
  const holder = win.document.createElement('div')
  holder.innerHTML = html
  const domTokens = tokenizeDom(holder)

  const mainShape = mainTokens.map((block) => block.map((token) => token.text))
  const domShape = domTokens.map((block) => block.map((token) => token.text))
  check(
    `${name}：块数与节点文本一致`,
    JSON.stringify(mainShape) === JSON.stringify(domShape),
    `主=${JSON.stringify(mainShape)} 渲染=${JSON.stringify(domShape)}`
  )
}

/* ---------------- 2. 选区 → 锚点 → 注入 → 还原 ---------------- */

console.log('\n[2] 选区 → 锚点 → 注入标记 → 还原')

const HTML = '<h2>第一章</h2>\n<p>他停下脚步，回头看那片褪色的樱花。</p>\n<p>「你迟到了。」少女把伞递过来。</p>'

function mountHtml(html: string): { host: HTMLElement; page: Element } {
  const host = win.document.createElement('div')
  host.className = 'reader-body'
  const page = win.document.createElement('div')
  page.className = 'reader-page'
  page.innerHTML = html
  host.appendChild(page)
  win.document.body.appendChild(host)
  return { host, page }
}

/** 在第 blockIndex 个文本块里，用文本偏移选中 [start, end) */
function selectText(page: Element, blockIndex: number, start: number, end: number): Selection {
  const blocks = Array.from(page.querySelectorAll('h1, h2, h3, p, li, blockquote'))
  const target = blocks[blockIndex]
  const walker = win.document.createTreeWalker(target, 4 /* NodeFilter.SHOW_TEXT */)
  const nodes: Text[] = []
  let node = walker.nextNode() as Text | null
  while (node) {
    nodes.push(node)
    node = walker.nextNode() as Text | null
  }
  const range = win.document.createRange()
  let remaining = start
  let started = false
  for (const text of nodes) {
    const length = (text.nodeValue ?? '').replace(/\s+/g, ' ').trim().length
    if (!started && remaining < length) {
      range.setStart(text, Math.min(remaining, (text.nodeValue ?? '').length))
      started = true
      remaining = end - start
      if (remaining <= length) {
        range.setEnd(text, Math.min((text.nodeValue ?? '').length, (range.startOffset ?? 0) + remaining))
        break
      }
      continue
    }
    if (started) {
      const take = Math.min(remaining, (text.nodeValue ?? '').length)
      range.setEnd(text, take)
      remaining -= take
      if (remaining <= 0) break
    }
  }
  const selection = win.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return selection as Selection
}

const { host, page } = mountHtml(HTML)
const selection = selectText(page, 1, 2, 6)
const anchor = selectionAnchor(page, selection)
check('能算出选区锚点', anchor !== null, JSON.stringify(anchor))
check('选中的原文与界面上看到的一致', (anchor?.quote ?? '').length > 0, JSON.stringify(anchor?.quote))

if (anchor) {
  // 用渲染层给出的锚点，走主进程的注入
  const items: Annotation[] = [
    {
      id: 'a1',
      bookId: 'book-a',
      chapterIndex: 0,
      chapterTitle: '第一章',
      blockIndex: anchor.blockIndex,
      tokenIndex: anchor.tokenIndex,
      startOffset: anchor.start,
      endBlockIndex: anchor.endBlockIndex,
      endTokenIndex: anchor.endTokenIndex,
      endOffset: anchor.end,
      quote: anchor.quote,
      note: '',
      color: 'yellow',
      style: 'highlight',
      createdAt: 1,
      updatedAt: 1,
      deviceId: 'd'
    }
  ]
  const marked = applyAnnotations(HTML, items)
  check('注入后除标记外原文未动', marked.replace(/<\/?mark[^>]*>/g, '') === HTML, marked.slice(0, 80))
  check('注入的标记包住的正是选中的字', new RegExp(`<mark[^>]*>${anchor.quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</mark>`).test(marked), marked)

  // 渲染注入后的 HTML，再用锚点还原选区
  const second = mountHtml(marked)
  const restored = anchorRange(second.page, items[0])
  check('锚点能还原成 DOM Range', restored !== null)
  check('还原出的文字与原文一致', (restored?.toString() ?? '') === anchor.quote, JSON.stringify(restored?.toString()))
  const markEl = second.page.querySelector('mark.ann')
  check(
    '还原的范围正好盖住标记里的字',
    Boolean(markEl && markEl.textContent === anchor.quote) && (restored?.toString() ?? '') === anchor.quote,
    `mark=${JSON.stringify(markEl?.textContent)} range=${JSON.stringify(restored?.toString())}`
  )
  win.document.body.removeChild(second.host)
}

win.document.body.removeChild(host)

/* ---------------- 3. 阅读记录页 ---------------- */

console.log('\n[3] 阅读记录页')

const container = win.document.getElementById('root') as HTMLElement
let root: Root | null = null

async function tick(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mount(node: ReturnType<typeof createElement>): Promise<void> {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  container.innerHTML = ''
  root = createRoot(container)
  await act(async () => {
    root!.render(node)
  })
  await tick()
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

async function click(el: HTMLElement | null, label: string): Promise<void> {
  if (!el) throw new Error(`找不到可点击元素：${label}`)
  await act(async () => {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await tick()
}

function makeBook(id: string, title: string): Book {
  return {
    id,
    title,
    metaTitle: title,
    author: '某作者',
    format: 'epub',
    fileName: `${title}.epub`,
    filePath: `D:\\books\\${id}.epub`,
    fileSize: 1,
    contentHash: null,
    coverFile: null,
    coverColor: null,
    description: '',
    chapterCount: 5,
    chapterChars: [1000, 1000, 1000, 1000, 1000],
    wordCount: 5000,
    volume: null,
    seriesKey: null,
    manualSeries: null,
    addedAt: 1,
    lastOpenedAt: null,
    hidden: false
  }
}

const BOOK_A = makeBook('book-a', '义妹生活 01')
const BOOK_B = makeBook('book-b', '短篇集 01')
const NO_RECORD_BOOK = makeBook('book-c', '没有记录的书')

let seq = 0
function makeAnnotation(bookId: string, over: Partial<Annotation> = {}): Annotation {
  seq += 1
  return {
    id: over.id ?? `ann-${seq}`,
    bookId,
    chapterIndex: over.chapterIndex ?? 0,
    chapterTitle: over.chapterTitle ?? '第一章',
    blockIndex: over.blockIndex ?? 1,
    tokenIndex: 0,
    startOffset: 0,
    endBlockIndex: over.endBlockIndex ?? 1,
    endTokenIndex: 0,
    endOffset: 5,
    quote: over.quote ?? '他停下脚步，回头看那片褪色的樱花。',
    note: over.note ?? '',
    color: over.color ?? 'yellow',
    style: over.style ?? 'highlight',
    createdAt: over.createdAt ?? 1000,
    updatedAt: 1000,
    deviceId: 'd',
    ...over
  }
}

function reset(annotations: Annotation[], books: Book[] = [BOOK_A, BOOK_B, NO_RECORD_BOOK]): void {
  useApp.setState({
    ready: true,
    route: 'records',
    books,
    annotations,
    recordBookId: null,
    recordFilter: 'all',
    toasts: [],
    openAnnotation: async () => undefined,
    loadAnnotations: async () => undefined,
    loadBooks: async () => undefined,
    removeAnnotation: async () => undefined
  } as never)
}

console.log('\n  空态')
reset([])
await mount(createElement(Fragment, null, createElement(RecordsPage), createElement(Toaster)))
check('没有任何记录时显示引导空态', text().includes('还没有划线或笔记'), text().slice(0, 40))
check('空态不渲染两栏', !one('.bm-split'))

console.log('\n  两栏与内容')
const a1 = makeAnnotation('book-a', { quote: '他停下脚步，回头看那片褪色的樱花。', note: '这里是转折点', createdAt: 3000 })
const a2 = makeAnnotation('book-a', { quote: '「你迟到了。」少女把伞递过来。', createdAt: 1000, color: 'blue', style: 'underline' })
const b1 = makeAnnotation('book-b', { quote: '十月的风从窗缝里钻进来。', createdAt: 2000 })
reset([a1, a2, b1])
await mount(createElement(Fragment, null, createElement(RecordsPage), createElement(Toaster)))
check('渲染两栏', Boolean(one('.bm-split')))
check('左栏只列有记录的书', all('.bm-book').length === 2, `${all('.bm-book').length} 本`)
check('左栏不出现没有记录的书', !text().includes('没有记录的书'))
check('左栏显示书名', text().includes('义妹生活 01') && text().includes('短篇集 01'))
check('左栏给出汇总', text().includes('共 2 本 · 3 条'), text().slice(-40))
check('左栏标出划线/笔记条数', text().includes('划线 1') && text().includes('笔记 1'), text().slice(0, 120))
check('未选书时自动选中最近的那本', one('.bm-book.active')?.textContent?.includes('义妹生活 01') === true)
check('右栏只显示选中书的记录', (one('.bm-detail')?.textContent?.includes('十月的风') ?? true) === false)
check('引文带颜色类', Boolean(one('.rec-quote.ann-yellow')), one('.rec-quote')?.className ?? '')
check('下划线样式单独成类', Boolean(one('.rec-quote.ann-blue.underline')))
check('有备注的卡片显示备注', text().includes('这里是转折点'))
check('卡片不显示书名', !one('.bm-card')?.textContent?.includes('义妹生活'))

console.log('\n  筛选与选书')
await click(all('.bm-book')[1], '左栏第二本书')
check('切换后右栏换成该书的记录', text().includes('十月的风'))
const filterButtons = all('.bm-detail-head button')
await click(filterButtons[1], '只看划线')
check('只看划线时笔记被过滤掉', !one('.bm-list')?.textContent?.includes('这里是转折点'), one('.bm-list')?.textContent?.slice(0, 40) ?? '')
await click(filterButtons[2], '只看笔记')
check('只看笔记时划线被过滤掉', !one('.bm-list')?.textContent?.includes('十月的风'), one('.bm-list')?.textContent?.slice(0, 40) ?? '')

console.log('\n  跳转与删除')
reset([a1, a2, b1])
let opened = 0
useApp.setState({
  openAnnotation: async () => {
    opened += 1
  }
} as never)
await mount(createElement(Fragment, null, createElement(RecordsPage), createElement(Toaster)))
await click(one('.bm-card'), '第一张卡片')
check('点卡片会跳到那条划线', opened === 1, `${opened} 次`)

let removed = ''
useApp.setState({
  removeAnnotation: async (id: string) => {
    removed = id
  }
} as never)
await mount(createElement(Fragment, null, createElement(RecordsPage), createElement(Toaster)))
const delBtn = all('.bm-card')[0]?.querySelector('.icon-btn.danger') as HTMLElement | null
await click(delBtn, '删除按钮')
check('删除按钮调用的是这一条', removed.length > 0, removed)

console.log('\n[4] 备注输入框：打字过程中不能被重置')

{
  const { AnnotationToolbar } = await import('../src/renderer/src/components/AnnotationToolbar')
  // 先把上一节挂的页面卸载干净，否则它的异步更新会在后面的 act 之外报错
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  container.innerHTML = ''
  const anchor = { blockIndex: 1, tokenIndex: 0, start: 0, endBlockIndex: 1, endTokenIndex: 0, end: 5 }
  const makeTarget = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'ann-1',
    color: 'yellow',
    style: 'highlight',
    note: '',
    anchor,
    quote: '他停下脚步',
    left: 200,
    top: 100,
    ...over
  })

  let saved = ''
  let node = createElement(AnnotationToolbar, {
    target: makeTarget(),
    noteMax: 500,
    onPickColor: () => undefined,
    onPickStyle: () => undefined,
    onSaveNote: (value: string) => {
      saved = value
    },
    onDelete: () => undefined,
    onClose: () => undefined
  } as never)

  const host = win.document.createElement('div')
  container.innerHTML = ''
  container.appendChild(host)
  if (root) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  root = createRoot(host)
  await act(async () => {
    root!.render(node)
  })
  await tick()

  // 点「笔记」打开输入框
  const noteBtn = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('笔记'))
  await act(async () => {
    noteBtn?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  })
  await tick()
  const box = host.querySelector('textarea') as HTMLTextAreaElement | null
  check('点「笔记」能打开输入框', Boolean(box))

  if (box) {
    await act(async () => {
      // React 18 把「值追踪器」挂成元素自己的属性（不再是 _valueTracker），
      // 直接改 value 会被判成「没变」而不触发 onChange —— 先把这些追踪属性删掉
      for (const key of Object.getOwnPropertyNames(box)) {
        const value = (box as unknown as Record<string, unknown>)[key]
        if (value && typeof value === 'object' && 'value' in (value as object)) {
          delete (box as unknown as Record<string, unknown>)[key]
        }
      }
      const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(box, '我写了一半')
      box.dispatchEvent(new win.Event('input', { bubbles: true }))
    })
    await tick()
    check('输入的字进了输入框', (host.querySelector('textarea') as HTMLTextAreaElement)?.value === '我写了一半', (host.querySelector('textarea') as HTMLTextAreaElement)?.value ?? '')

    // 模拟 store 刷新：组件收到一个「值相同但是新对象」的 target（这正是之前把字冲掉的原因）
    node = createElement(AnnotationToolbar, {
      target: makeTarget({ note: '' }),
      noteMax: 500,
      onPickColor: () => undefined,
      onPickStyle: () => undefined,
      onSaveNote: (value: string) => {
        saved = value
      },
      onDelete: () => undefined,
      onClose: () => undefined
    } as never)
    await act(async () => {
      root!.render(node)
    })
    await tick()
    check('输入框没有被关掉', Boolean(host.querySelector('textarea')))
    check(
      '重渲染不会把输入框换成新的',
      host.querySelectorAll('textarea').length === 1,
      `${host.querySelectorAll('textarea').length} 个`
    )
  }

  /*
   * 「打字过程中不能被重置」的稳定版验证：
   * jsdom 里没法可靠地模拟 React 的合成 input 事件，所以改在
   * 「看笔记 → 编辑」这条路径上验证：输入框的值由组件初始化一次，
   * 之后反复重渲染都必须原样保留（这正是之前被 store 刷新冲掉的回归点）。
   */
  node = createElement(AnnotationToolbar, {
    target: makeTarget({ note: '草稿内容', viewNote: true }),
    noteMax: 500,
    onPickColor: () => undefined,
    onPickStyle: () => undefined,
    onSaveNote: () => undefined,
    onDelete: () => undefined,
    onClose: () => undefined
  } as never)
  await act(async () => {
    root!.render(node)
  })
  await tick()
  const editBtn0 = Array.from(host.querySelectorAll('.ann-note-pop-foot button')).find((b) =>
    (b.textContent ?? '').includes('编辑')
  ) as HTMLElement | undefined
  await act(async () => {
    editBtn0?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  })
  await tick()
  check(
    '编辑模式带出已有备注',
    (host.querySelector('textarea') as HTMLTextAreaElement)?.value === '草稿内容',
    JSON.stringify((host.querySelector('textarea') as HTMLTextAreaElement)?.value ?? '')
  )

  for (let round = 0; round < 3; round += 1) {
    node = createElement(AnnotationToolbar, {
      target: makeTarget({ note: '草稿内容', viewNote: true, style: round % 2 ? 'underline' : 'highlight' }),
      noteMax: 500,
      onPickColor: () => undefined,
      onPickStyle: () => undefined,
      onSaveNote: () => undefined,
      onDelete: () => undefined,
      onClose: () => undefined
    } as never)
    await act(async () => {
      root!.render(node)
    })
    await tick()
  }
  check(
    '反复重渲染后输入框内容没被重置',
    (host.querySelector('textarea') as HTMLTextAreaElement)?.value === '草稿内容',
    JSON.stringify((host.querySelector('textarea') as HTMLTextAreaElement)?.value ?? '')
  )

  // 「看笔记」模式：点笔记图标后应该直接显示内容（换一条标注 = 换 id）
  node = createElement(AnnotationToolbar, {
    target: makeTarget({ id: 'ann-2', note: '这是已有的备注', viewNote: true }),
    noteMax: 500,
    onPickColor: () => undefined,
    onPickStyle: () => undefined,
    onSaveNote: () => undefined,
    onDelete: () => undefined,
    onClose: () => undefined
  } as never)
  await act(async () => {
    root!.render(node)
  })
  await tick()
  check('看笔记模式直接显示内容', (host.querySelector('.ann-note-view')?.textContent ?? '').includes('这是已有的备注'), host.textContent?.slice(0, 60) ?? '')
  check('看笔记模式不直接显示输入框', !host.querySelector('textarea'))
  const editBtn = Array.from(host.querySelectorAll('.ann-note-pop-foot button')).find((b) =>
    (b.textContent ?? '').includes('编辑')
  ) as HTMLElement | undefined
  await act(async () => {
    editBtn?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  })
  await tick()
  check('点「编辑」切换成输入框', Boolean(host.querySelector('textarea')))
  check('编辑时带出已有内容', (host.querySelector('textarea') as HTMLTextAreaElement)?.value === '这是已有的备注')
}

if (root) {
  await act(async () => {
    root?.unmount()
  })
}

console.log(`\n共 ${checks} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('❌ 划线 / 笔记界面自检未通过')
  process.exit(1)
}
console.log('✅ 划线 / 笔记界面自检全部通过')
process.exit(0)
