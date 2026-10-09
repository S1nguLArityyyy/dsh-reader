/**
 * 划线「显示出来」的链路自检。
 *
 * 背景：主进程在 reader:chapter 里把标注包成 <mark> 注入章节 HTML，
 * 所以每次标注增删改之后界面都必须**重新取一次本章 HTML**，
 * 否则数据存进去了但画面上什么都看不到（用户实际反馈过这个问题）。
 *
 * 这里用假的 window.api 走真实 store 动作，验证：
 *   1. 新建标注后重新取章节，回来的 HTML 里带 <mark>
 *   2. 改颜色 / 改样式 / 加备注后，重新取的 HTML 跟着变
 *   3. 删除后重新取，标记消失
 *   4. 渲染层给出的锚点在主进程注入时能对上（界面选中 → 数据 → 显示 整条闭环）
 */
import { JSDOM } from 'jsdom'
import { planForSelection, tokenizeHtml } from '../src/shared/annotations'
import { applyAnnotations } from '../src/main/annotations'
import { selectionAnchor } from '../src/renderer/src/lib/annotation-anchor'
import { useApp as useAppImport } from '../src/renderer/src/store/app'
import type { Annotation, Book } from '../src/shared/types'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
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

/* ---------------- 服务端：真实主进程逻辑 ---------------- */

const CHAPTER_HTML =
  '<h2>第一章</h2>\n<p>他停下脚步，回头看那片褪色的樱花。</p>\n<p>「你迟到了。」少女把伞递过来。</p>'

const BOOK: Book = {
  id: 'book-a',
  title: '测试书 01',
  metaTitle: '测试书',
  author: '某作者',
  format: 'epub',
  fileName: '测试书 01.epub',
  filePath: 'D:\\books\\book-a.epub',
  fileSize: 1,
  contentHash: null,
  coverFile: null,
  coverColor: null,
  description: '',
  chapterCount: 3,
  chapterChars: [1000, 1000, 1000],
  wordCount: 3000,
  volume: null,
  seriesKey: null,
  manualSeries: null,
  addedAt: 1,
  lastOpenedAt: null,
  hidden: false
}

/** 主进程侧的真实存储（annotations.json 的内存副本） */
let stored: Annotation[] = []
let annotationSeq = 0
/** 每次向主进程要章节都记一笔，用来验证「标注一变就重取」 */
let chapterFetches = 0

function chapterFromMain(chapterIndex = 0): string {
  chapterFetches += 1
  // 主进程只注入「这一章」的标注
  return applyAnnotations(
    CHAPTER_HTML,
    stored.filter((item) => !item.deletedAt && item.chapterIndex === chapterIndex)
  )
}

const api = {
  reader: {
    open: async () => ({ book: BOOK, toc: [], chapters: [{ index: 0, label: '第一章', href: 'c1.xhtml' }], progress: null }),
    chapter: async (bookId: string, index: number) => ({
      index,
      label: index === 0 ? '第一章' : '第二章',
      total: 2,
      html: chapterFromMain(index)
    }),
    setProgress: async () => ({}),
    tick: async () => true
  },
  annotations: {
    list: async () => stored.filter((item) => !item.deletedAt),
    add: async (input: {
      bookId: string
      chapterIndex: number
      chapterTitle: string
      blockIndex: number
      tokenIndex: number
      startOffset: number
      endBlockIndex: number
      endTokenIndex: number
      endOffset: number
      quote: string
      note?: string
      color: Annotation['color']
      style: Annotation['style']
    }) => {
      annotationSeq += 1
      const created: Annotation = {
        id: `ann-${annotationSeq}`,
        bookId: input.bookId,
        chapterIndex: input.chapterIndex,
        chapterTitle: input.chapterTitle,
        blockIndex: input.blockIndex,
        tokenIndex: input.tokenIndex,
        startOffset: input.startOffset,
        endBlockIndex: input.endBlockIndex,
        endTokenIndex: input.endTokenIndex,
        endOffset: input.endOffset,
        quote: input.quote,
        note: input.note ?? '',
        color: input.color,
        style: input.style,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deviceId: 'd'
      }
      stored = [...stored, created]
      return created
    },
    update: async (id: string, patch: Partial<Annotation>) => {
      stored = stored.map((item) => (item.id === id ? { ...item, ...patch } : item))
      return stored.find((item) => item.id === id) ?? null
    },
    remove: async (id: string) => {
      stored = stored.map((item) => (item.id === id ? { ...item, deletedAt: Date.now() } : item))
      return stored.find((item) => item.id === id) ?? null
    },
    restore: async (id: string) => {
      stored = stored.map((item) => {
        if (item.id !== id) return item
        const { deletedAt: _drop, ...rest } = item
        return rest as Annotation
      })
      return stored.find((item) => item.id === id) ?? null
    }
  },
  bookmarks: { list: async () => [], remaining: async () => 99 },
  library: { list: async () => [BOOK] },
  stats: { get: async () => null },
  settings: { get: async () => null }
}
define('api', api)
;(win as unknown as { api: unknown }).api = api

/* ---------------- 场景 ---------------- */

console.log('\n[1] 界面上划一条线 → 数据库 → 重新取章节时能看到标记')

// 模拟阅读器打开的正文 DOM
const page = win.document.createElement('div')
page.className = 'reader-page'
page.innerHTML = CHAPTER_HTML
win.document.body.appendChild(page)

// 用户选中第二段的「，回头看」（跨行内无标签，稳定可控）
const target = page.querySelectorAll('p')[0].firstChild as Text
const range = win.document.createRange()
range.setStart(target, 2)
range.setEnd(target, 6)
const selection = win.getSelection()
selection?.removeAllRanges()
selection?.addRange(range)

const anchor = selectionAnchor(page, selection)
check('渲染层算出了选区锚点', anchor !== null, JSON.stringify(anchor))

await useApp.getState().openReader(BOOK.id)
const opened = useApp.getState().reader
check('打开书籍后拿到章节 HTML', opened.html.length > 0, `${opened.html.length} 字符`)
check('此时还没有任何标记', !opened.html.includes('<mark'), opened.html.slice(0, 60))
check('取章节次数 = 1', chapterFetches === 1, `${chapterFetches} 次`)

const created = await useApp.getState().addAnnotation({
  bookId: BOOK.id,
  chapterIndex: 0,
  chapterTitle: '第一章',
  blockIndex: anchor!.blockIndex,
  tokenIndex: anchor!.tokenIndex,
  startOffset: anchor!.start,
  endBlockIndex: anchor!.endBlockIndex,
  endTokenIndex: anchor!.endTokenIndex,
  endOffset: anchor!.end,
  quote: anchor!.quote,
  color: 'yellow',
  style: 'highlight'
})
check('标注已入库', Boolean(created?.id), created?.id ?? 'null')
check('store 里能看到这条标注', useApp.getState().annotations.length === 1)

// 界面这一侧的动作：标注变了就重新取本章 HTML
await useApp.getState().reloadChapter()
const afterAdd = useApp.getState().reader.html
check('重新取章节后 HTML 里出现了标记', afterAdd.includes('<mark'), afterAdd)
check(
  '标记包住的正是选中的字',
  new RegExp(`<mark[^>]*>${anchor!.quote}</mark>`).test(afterAdd),
  afterAdd.slice(afterAdd.indexOf('<mark'), afterAdd.indexOf('</mark>') + 8)
)
check('标记带上了颜色类', afterAdd.includes('ann-yellow'), afterAdd.match(/<mark[^>]*>/)?.[0] ?? '')
check('标记带上了 data-ann（点击时要用）', afterAdd.includes(`data-ann="${created!.id}"`))
check('取章节次数增加了（初始 1 次 + 重新载入 1 次）', chapterFetches === 2, `${chapterFetches} 次`)

console.log('\n[2] 改颜色 / 改样式 / 加备注后，标记跟着变')

await useApp.getState().updateAnnotation(created!.id, { color: 'blue' })
await useApp.getState().reloadChapter()
check('颜色改成蓝', useApp.getState().reader.html.includes('ann-blue'), useApp.getState().reader.html.match(/<mark[^>]*>/)?.[0] ?? '')

await useApp.getState().updateAnnotation(created!.id, { style: 'underline' })
await useApp.getState().reloadChapter()
check('样式改成下划线', useApp.getState().reader.html.includes('ann-underline'))

await useApp.getState().updateAnnotation(created!.id, { note: '这里是转折点' })
await useApp.getState().reloadChapter()
check('加备注后标记带 data-note（列表里会显示小圆点）', useApp.getState().reader.html.includes('data-note="1"'), useApp.getState().reader.html.match(/<mark[^>]*>/)?.[0] ?? '')

console.log('\n[3] 删除后标记消失')

await useApp.getState().removeAnnotation(created!.id)
await useApp.getState().reloadChapter()
check('删除后 HTML 里没有标记了', !useApp.getState().reader.html.includes('<mark'), useApp.getState().reader.html.slice(0, 80))
check('store 里也没有了', useApp.getState().annotations.length === 0)

console.log('\n[4] 换章节时按章过滤')

// 换到第 2 章：主进程只注入这一章的标注
const second = await useApp.getState().addAnnotation({
  bookId: BOOK.id,
  chapterIndex: 1,
  chapterTitle: '第二章',
  blockIndex: 1,
  tokenIndex: 0,
  startOffset: 0,
  endBlockIndex: 1,
  endTokenIndex: 0,
  endOffset: 4,
  quote: '他停下',
  color: 'pink',
  style: 'highlight'
})
check('第 2 章的标注入库', Boolean(second?.id))
await useApp.getState().reloadChapter()
check('当前在第 1 章时不显示第 2 章的标记', !useApp.getState().reader.html.includes('ann-pink'), useApp.getState().reader.html.slice(0, 60))

console.log('\n[5] 主进程切词与注入对渲染层锚点的接受度')

const tokens = tokenizeHtml(CHAPTER_HTML)
check('锚点的块号在切词结果范围内', anchor!.blockIndex < tokens.length, `${anchor!.blockIndex} < ${tokens.length}`)
check(
  '锚点指向的文本节点存在',
  Boolean(tokens[anchor!.blockIndex]?.[anchor!.tokenIndex]),
  `${anchor!.blockIndex}:${anchor!.tokenIndex}`
)
check(
  '锚点偏移落在该节点长度内',
  anchor!.start >= 0 && anchor!.end <= (tokens[anchor!.blockIndex]?.[anchor!.endTokenIndex]?.text.length ?? 0),
  `${anchor!.start}~${anchor!.end} / ${tokens[anchor!.blockIndex]?.[anchor!.endTokenIndex]?.text.length ?? 0}`
)

console.log('\n[6] 同一段重复划线：只应剩一条，且删除是真的删掉')
{
  stored = []
  annotationSeq = 0
  await useApp.getState().loadAnnotations()

  const span = {
    blockIndex: anchor!.blockIndex,
    tokenIndex: anchor!.tokenIndex,
    startOffset: anchor!.start,
    endBlockIndex: anchor!.endBlockIndex,
    endTokenIndex: anchor!.endTokenIndex,
    endOffset: anchor!.end
  }

  // 模拟「同一段连续点颜色」：每次都按当前状态重算重叠（界面上就是这么做的）
  const paint = async (color: string): Promise<void> => {
    const state = useApp.getState()
    const tokens = tokenizeHtml(state.reader.html)
    const plan = planForSelection(
      tokens,
      { id: '', ...span },
      state.annotations.filter((item) => !item.deletedAt)
    )
    for (const removeId of plan.remove) await state.removeAnnotation(removeId)
    for (const piece of plan.trim) {
      await state.updateAnnotation(piece.id, {
        blockIndex: piece.blockIndex,
        tokenIndex: piece.tokenIndex,
        startOffset: piece.startOffset,
        endBlockIndex: piece.endBlockIndex,
        endTokenIndex: piece.endTokenIndex,
        endOffset: piece.endOffset,
        quote: piece.quote
      })
    }
    await state.addAnnotation({
      bookId: BOOK.id,
      chapterIndex: 0,
      chapterTitle: '第一章',
      ...span,
      quote: anchor!.quote,
      note: '',
      color: color as Annotation['color'],
      style: 'highlight'
    })
  }

  await paint('yellow')
  check('第一次划线：1 条', useApp.getState().annotations.length === 1, `${useApp.getState().annotations.length} 条`)
  await paint('blue')
  check('同段再点蓝色：仍然 1 条（不叠加）', useApp.getState().annotations.length === 1, `${useApp.getState().annotations.length} 条`)
  check('留下的是蓝色那条', useApp.getState().annotations[0]?.color === 'blue', String(useApp.getState().annotations[0]?.color))
  await paint('pink')
  check('再点粉色：仍然 1 条', useApp.getState().annotations.length === 1, `${useApp.getState().annotations.length} 条`)
  check('颜色是最后一次点的', useApp.getState().annotations[0]?.color === 'pink', String(useApp.getState().annotations[0]?.color))

  await useApp.getState().reloadChapter()
  const html = useApp.getState().reader.html
  check('正文里只有一个标记（没有叠层）', (html.match(/<mark/g) ?? []).length === 1, `${(html.match(/<mark/g) ?? []).length} 个`)
  check('标记是最后点的那种颜色', html.includes('ann-pink'), html.match(/<mark[^>]*>/)?.[0] ?? '')

  // 删除：界面说删了，数据就必须真没了
  const target = useApp.getState().annotations[0]
  await useApp.getState().removeAnnotation(target.id)
  check('删除后 store 里为空', useApp.getState().annotations.length === 0, `${useApp.getState().annotations.length} 条`)
  check('主进程侧也已标记删除', stored.every((item) => item.deletedAt !== undefined), JSON.stringify(stored.map((i) => ({ id: i.id, del: i.deletedAt ?? null }))))
  await useApp.getState().reloadChapter()
  check('重新取章节后标记真的没了', !useApp.getState().reader.html.includes('<mark'), useApp.getState().reader.html.slice(0, 60))

  // 撤销要能把它带回来
  await useApp.getState().removeAnnotation('nonexistent')
  check('删除不存在的 id 不会崩', true)
}

console.log(`\n共 ${checks} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('❌ 划线显示链路自检未通过')
  process.exit(1)
}
console.log('✅ 划线显示链路自检全部通过')
process.exit(0)
