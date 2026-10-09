/**
 * 书签锚点自检（由 scripts/bookmark-anchor-check.mjs 打包后运行）。
 *
 * 用 jsdom 造一个「有滚动、有段落坐标」的假阅读器 DOM，
 * 验证章内比例换算、还原、摘录提取与跳转校验 —— 这几条是书签最容易出错的地方，
 * 而且 jsdom 没有排版引擎，所以用可预期的假数值把逻辑钉死。
 */
import { JSDOM } from 'jsdom'
import {
  applyScrollRatio,
  contentBlocks,
  currentExcerpt,
  excerptMatches,
  pagedRatio,
  scrollRatioOf,
  topVisibleBlock
} from '../src/renderer/src/lib/bookmark-anchor'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 假 DOM ---------------- */

interface FakeBlock {
  el: HTMLElement
  top: number
  bottom: number
}

function makeReader(paragraphs: string[], viewHeight = 600): { body: HTMLElement; blocks: FakeBlock[] } {
  const dom = new JSDOM(
    `<div class="reader-body"><div class="reader-page">${paragraphs
      .map((text) => `<p>${text}</p>`)
      .join('')}</div></div>`
  )
  const body = dom.window.document.querySelector('.reader-body') as HTMLElement
  const page = body.querySelector('.reader-page') as HTMLElement

  // jsdom 不做排版：滚动高度、可视高度与每个段落的坐标都手动给定
  Object.defineProperty(body, 'scrollHeight', { value: paragraphs.length * 200 + viewHeight, configurable: true })
  Object.defineProperty(body, 'clientHeight', { value: viewHeight, configurable: true })
  Object.defineProperty(page, 'clientHeight', { value: viewHeight, configurable: true })
  Object.defineProperty(body, 'scrollTop', { value: 0, writable: true, configurable: true })

  const blocks: FakeBlock[] = Array.from(page.querySelectorAll('p')).map((el, index) => {
    const top = index * 200
    const bottom = top + 190
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ top, bottom, left: 0, right: 700, width: 700, height: 190, x: 0, y: top, toJSON: () => ({}) }),
      configurable: true
    })
    return { el: el as HTMLElement, top, bottom }
  })

  return { body, blocks }
}

const PARAS = [
  '第一段：他停下脚步，回头看那片褪色的樱花。',
  '第二段：「你迟到了。」少女把伞递过来。',
  '第三段：风把花瓣吹到他肩上。',
  '第四段：这一章在这里结束。'
]

/* ---------------- 1. 章内比例 ---------------- */

console.log('\n[1] 章内比例换算')
const { body, blocks } = makeReader(PARAS)
check('内容块全部被识别', contentBlocks(body).length === PARAS.length, `${contentBlocks(body).length} 段`)
check('顶部时比例为 0', scrollRatioOf(body) === 0)

body.scrollTop = 200
check('滚到 200/800 → 0.25', Math.abs(scrollRatioOf(body) - 0.25) < 1e-9, String(scrollRatioOf(body)))

body.scrollTop = 900
check('滚过底 → 夹到 1', scrollRatioOf(body) === 1)

body.scrollTop = -50
check('负数 → 夹到 0', scrollRatioOf(body) === 0)

check('没有滚动空间时为 0', scrollRatioOf(makeReader(['短章'], 600).body) === 0)
check('body 为 null 时为 0', scrollRatioOf(null) === 0)

console.log('\n[2] 比例还原')
applyScrollRatio(body, 0.5)
check('0.5 → 滚到 400', body.scrollTop === 400, String(body.scrollTop))
applyScrollRatio(body, 2)
check('超过 1 也夹住', body.scrollTop === (body.scrollHeight ?? 0) - (body.clientHeight ?? 0), String(body.scrollTop))
applyScrollRatio(null, 0.5)
check('null 不报错', true)

console.log('\n[3] 翻页模式下的比例')
check('第 1/4 屏 → 0.25', Math.abs(pagedRatio(1, 4) - 0.25) < 1e-9)
check('只有一屏 → 0', pagedRatio(0, 1) === 0)
check('越界夹住', pagedRatio(9, 4) === 1)

console.log('\n[4] 摘录提取（滚动模式）')
body.scrollTop = 0
check('顶部 → 取第一段', currentExcerpt(body, 'scroll') === PARAS[0], currentExcerpt(body, 'scroll'))
body.scrollTop = 100
check('第一段还在视口里 → 仍是第一段', currentExcerpt(body, 'scroll') === PARAS[0], currentExcerpt(body, 'scroll'))
body.scrollTop = 200
check('第一段刚好滚出去 → 取第二段', currentExcerpt(body, 'scroll') === PARAS[1], currentExcerpt(body, 'scroll'))
body.scrollTop = 300
check('第二段占住视口顶部 → 仍是第二段', currentExcerpt(body, 'scroll') === PARAS[1], currentExcerpt(body, 'scroll'))
body.scrollTop = 2000
check('滚到底 → 取最后一段', currentExcerpt(body, 'scroll') === PARAS[3], currentExcerpt(body, 'scroll'))
check('摘录不含标签', !currentExcerpt(body, 'scroll').includes('<'))
check('翻页模式取章首一段', currentExcerpt(body, 'paged') === PARAS[0])
check('body 为 null 时为空串', currentExcerpt(null, 'scroll') === '')

console.log('\n[5] 可见块判定')
check('视口顶部命中第一段', topVisibleBlock(body, 0) === blocks[0].el)
check('滚到 190 仍是第一段（底边还没出去）', topVisibleBlock(body, 190) === blocks[0].el)
check('滚到 200 命中第二段', topVisibleBlock(body, 200) === blocks[1].el)
check('滚过全书命中最后一段', topVisibleBlock(body, 5000) === blocks[3].el)

console.log('\n[6] 摘录长度与清洗')
const long = '长'.repeat(200)
const longDom = makeReader([long])
check('摘录截断到 60 字', currentExcerpt(longDom.body, 'scroll').length === 60, String(currentExcerpt(longDom.body, 'scroll').length))
const messy = makeReader(['  第一段\n\n   有空   白  '])
check('空白被压平', currentExcerpt(messy.body, 'scroll') === '第一段 有空 白', currentExcerpt(messy.body, 'scroll'))
const noText = makeReader(['<span></span>'])
check('没有正文时为空的短串', currentExcerpt(noText.body, 'scroll').length === 0)

console.log('\n[7] 跳转校验')
check('完全相同 → 命中', excerptMatches(PARAS[0], PARAS[0]))
check('前后缀不同但开头一致 → 命中', excerptMatches(PARAS[0], `${PARAS[0]}又补了一句`))
check('换行差异也算命中', excerptMatches('他停下脚步\n回头看', '他停下脚步 回头看那片'))
check('完全不同的段落 → 不命中', !excerptMatches(PARAS[0], PARAS[2]))
check('太短不做判定（避免误报）', excerptMatches('短', '完全不相干的一段文字'))

console.log(`\n共 ${checks} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('❌ 书签锚点自检未通过')
  process.exit(1)
}
console.log('✅ 书签锚点自检全部通过')
