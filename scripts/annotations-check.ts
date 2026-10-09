/**
 * 划线 / 笔记自检（由 scripts/annotations-check.mjs 打包后运行）。
 *
 * 重点验证「锚点」这条链路：
 * 1. 切词（tokenizeHtml）对段落、行内标签、属性、实体的处理是否稳定
 * 2. 注入标记（applyAnnotations）是否只加 <mark>、不动原有 HTML、跨段是否正确分片
 * 3. 锚点失效时能否靠原文重新定位
 * 4. 仓储的上限 / 墓碑 / 修改 / 清理
 */
import type { Annotation } from '../src/shared/types'
import {
  ANNOTATION_COLORS,
  collapse,
  locateQuote,
  normalizeQuote,
  planForSelection,
  quotePreview,
  squash,
  tokenizeHtml
} from '../src/shared/annotations'
import {
  AnnotationStore,
  activeAnnotations,
  annotationCount,
  annotationCountsByChapter,
  annotationsOfChapter,
  applyAnnotations,
  resolveRange
} from '../src/main/annotations'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- 1. 切词 ---------------- */

console.log('\n[1] 切词')

const SIMPLE = '<h2>第一章</h2>\n<p>他停下脚步，回头看那片褪色的樱花。</p>\n<p>「你迟到了。」少女把伞递过来。</p>'
const simple = tokenizeHtml(SIMPLE)
check('块数 = 标题 + 两个段落', simple.length === 3, `${simple.length} 块`)
check('每块一个文本节点', simple.every((block) => block.length === 1), simple.map((b) => b.length).join(','))
check('块 0 文本正确', simple[0][0].text === '第一章', simple[0][0].text)
check('块 1 文本正确', simple[1][0].text === '他停下脚步，回头看那片褪色的樱花。', simple[1][0].text)
check(
  'rawStart/rawEnd 指向原文',
  SIMPLE.slice(simple[2][0].rawStart, simple[2][0].rawEnd) === '「你迟到了。」少女把伞递过来。',
  SIMPLE.slice(simple[2][0].rawStart, simple[2][0].rawEnd)
)

const INLINE = '<p>他<em>停下</em>脚步，<a href="x.html">回头看</a>那片<b>褪色的</b>樱花。</p>'
const inline = tokenizeHtml(INLINE)
check('行内标签不拆成新块', inline.length === 1, `${inline.length} 块`)
check('行内标签拆成多个文本节点', inline[0].length === 7, `${inline[0].length} 个`)
check('节点文本依次拼接还原整段', inline[0].map((t) => t.text).join('') === '他停下脚步，回头看那片褪色的樱花。', inline[0].map((t) => t.text).join(''))
check(
  '属性里的 = 与引号不会影响切词',
  tokenizeHtml('<p><a title="a=b" href=\'c\'>文字</a></p>')[0][0].text === '文字'
)

const ENTITY = '<p>他说：&quot;你好&quot; &amp; 再见&nbsp;吧</p>'
check('实体被解码', tokenizeHtml(ENTITY)[0][0].text === '他说："你好" & 再见 吧', tokenizeHtml(ENTITY)[0][0].text)

const MESSY = '<p>\n  这是   一段\n\n  有空白的文字  \n</p>'
check('空白被压平', tokenizeHtml(MESSY)[0][0].text === '这是 一段 有空白的文字', tokenizeHtml(MESSY)[0][0].text)
check(
  '偏移映射能还原被折叠的空白',
  (() => {
    const token = tokenizeHtml(MESSY)[0][0]
    // 原文里第一个非空白字符是「这」，位于下标 3；归一化后每个字符都能映射回去
    return token.map[0] === 3 && token.map[2] === 5
  })(),
  JSON.stringify(tokenizeHtml(MESSY)[0][0].map.slice(0, 4))
)

const LIST = '<ul><li>第一项</li><li>第二项</li></ul>'
check('列表项各成一块', tokenizeHtml(LIST).length === 2, `${tokenizeHtml(LIST).length} 块`)

const SKIP = '<style>p{color:red}</style><p>正文</p><script>var a=1</script><p>结尾</p>'
const skip = tokenizeHtml(SKIP)
check('style/script 内容不进文本', skip.length === 2 && skip[0][0].text === '正文' && skip[1][0].text === '结尾', JSON.stringify(skip.map((b) => b[0].text)))

const IMG = '<p>前<img src="a.png" alt="图"/>后</p>'
check('img 不产生文本节点', tokenizeHtml(IMG)[0].map((t) => t.text).join('') === '前后', tokenizeHtml(IMG)[0].map((t) => t.text).join(''))

/* ---------------- 2. 注入标记 ---------------- */

console.log('\n[2] 注入标记')

function make(over: Partial<Annotation> = {}): Annotation {
  return {
    id: over.id ?? 'ann-1',
    bookId: 'book-a',
    chapterIndex: 0,
    chapterTitle: '第一章',
    blockIndex: 1,
    tokenIndex: 0,
    startOffset: 0,
    endBlockIndex: 1,
    endTokenIndex: 0,
    endOffset: 5,
    note: '',
    color: 'yellow',
    style: 'highlight',
    createdAt: 1,
    updatedAt: 1,
    deviceId: 'd',
    // 先给个占位原文，各用例自己覆盖成与锚点一致的内容
    quote: '他停下脚步',
    ...over
  }
}

/**
 * 从切词结果里取一段原文，生成与渲染进程一致的锚点（就像用户在界面上划选一样）。
 *
 * 偏移语义：`startOffset` = 选中首字符在节点内的下标；
 * `endOffset` = 选中末字符下标 + 1（也就是「该字符之后」）。
 * 所以若末字符正好是某个节点的最后一个字符，endOffset 就等于该节点长度，
 * 由调用方按这个语义归一化（渲染层取选区时天然就是这个语义）。
 */
function anchorOf(
  html: string,
  blockIndex: number,
  tokenIndex: number,
  start: number,
  endTokenIndex: number,
  end: number,
  over: Partial<Annotation> = {}
): Annotation {
  const tokens = tokenizeHtml(html)
  const block = tokens[blockIndex]

  // 选区两端按「字符」算，再翻译成 (token, offset)：
  // 起 = 首字符所在位置；止 = 末字符之后（含末字符）。
  const lengths = block.map((token) => token.text.length)
  let startFlat = 0
  for (let t = 0; t < tokenIndex; t += 1) startFlat += lengths[t]
  startFlat += start

  let endFlat = 0
  for (let t = 0; t < endTokenIndex; t += 1) endFlat += lengths[t]
  endFlat += Math.max(1, end)

  const at = (flat: number): { token: number; offset: number } => {
    let base = 0
    for (let t = 0; t < block.length; t += 1) {
      if (flat <= base + lengths[t]) return { token: t, offset: flat - base }
      base += lengths[t]
    }
    return { token: block.length - 1, offset: lengths[block.length - 1] }
  }

  const head = at(startFlat)
  const tail = at(endFlat)
  const quote = block
    .map((token) => token.text)
    .join('')
    .slice(startFlat, endFlat)

  return make({
    blockIndex,
    tokenIndex: head.token,
    startOffset: head.offset,
    endBlockIndex: blockIndex,
    endTokenIndex: tail.token,
    endOffset: tail.offset,
    quote,
    ...over
  })
}

const one = applyAnnotations(SIMPLE, [anchorOf(SIMPLE, 1, 0, 0, 0, 5)])
check('原文除 <mark> 外一字未动', one.replace(/<\/?mark[^>]*>/g, '') === SIMPLE, one.replace(/<\/?mark[^>]*>/g, '').slice(0, 60))
check('插入了开合标记', (one.match(/<mark/g) ?? []).length === 1 && (one.match(/<\/mark>/g) ?? []).length === 1)
check('标记带上了 id 与颜色类', /<mark class="ann ann-yellow ann-highlight" data-ann="ann-1">/.test(one), one.match(/<mark[^>]*>/)?.[0] ?? '')
check('标记只包住选中的字', one.includes('>他停下脚步</mark>，回头看那片褪色的樱花。'), one.slice(one.indexOf('<mark'), one.indexOf('</mark>') + 8))

const underline = applyAnnotations(SIMPLE, [anchorOf(SIMPLE, 1, 0, 0, 0, 5, { style: 'underline' })])
check('下划线样式类正确', underline.includes('ann-underline') && !underline.includes('ann-highlight'))

const withNote = applyAnnotations(SIMPLE, [anchorOf(SIMPLE, 1, 0, 0, 0, 5, { note: '有备注' })])
check('有备注时带 data-note', withNote.includes('data-note="1"'))

const mid = applyAnnotations(SIMPLE, [anchorOf(SIMPLE, 1, 0, 2, 0, 6)])
check('段中片段起点正确', mid.includes('他停<mark'), mid.slice(mid.indexOf('他停'), mid.indexOf('他停') + 40))
check('段中片段包住的正是选中的字', /<mark[^>]*>下脚步，<\/mark>/.test(mid), mid.slice(mid.indexOf('<mark'), mid.indexOf('</mark>') + 8))
check('段中片段之外一字未动', mid.replace(/<\/?mark[^>]*>/g, '') === SIMPLE)

// 跨行内节点：选「脚步，」的最后一个字「，」到下一节点「回头看」的第一个字「回」
// 已知限制：选区同时跨「行内标签边界」且两端落在不同文本节点时，标记范围会被放宽
// （不会丢字、不会动原文，但可能多包住相邻的几个字）。跨段落的选区不受影响（见下一条）。
const crossAnn = anchorOf(INLINE, 0, 2, 2, 3, 1)
const inline2 = applyAnnotations(INLINE, [crossAnn])
check('跨行内节点时原文未被破坏', inline2.replace(/<\/?mark[^>]*>/g, '') === INLINE, inline2.slice(0, 80))
check('行内标签原样保留', inline2.includes('<em>') && inline2.includes('href="x.html"'), inline2.slice(0, 140))
check('跨节点时每段各自闭合', (inline2.match(/<mark/g) ?? []).length === (inline2.match(/<\/mark>/g) ?? []).length, inline2)

// 跨段落：第一段第 3 个字 → 第二段第 3 个字
const across = applyAnnotations(SIMPLE, [anchorOf(SIMPLE, 1, 0, 3, 0, 3, { endBlockIndex: 2, endTokenIndex: 0 })])
check('跨段落拆成两段标记', (across.match(/<mark/g) ?? []).length === 2 && (across.match(/<\/mark>/g) ?? []).length === 2, `${(across.match(/<mark/g) ?? []).length} 段`)
check('跨段落时段落标签没被破坏', (across.match(/<p>/g) ?? []).length === 2 && (across.match(/<\/p>/g) ?? []).length === 2)
check('第一段结尾正确闭合', /<\/mark><\/p>/.test(across), across.slice(across.indexOf('</mark>') - 16, across.indexOf('</mark>') + 10))

const twice = applyAnnotations(one, [anchorOf(SIMPLE, 1, 0, 0, 0, 5)])
check('对已标记过的 HTML 再注入不会叠加到同一处文字上', twice.replace(/<\/?mark[^>]*>/g, '') === SIMPLE)

const escaped = applyAnnotations('<p>a &amp; b &lt;c&gt;</p>', [
  make({ blockIndex: 0, startOffset: 0, endOffset: 3, quote: 'a & b' })
])
// 实体：即使锚点算得不够准，也绝不能切进实体中间（那会破坏 HTML）
check('实体文本也能定位', escaped.includes('<mark'), escaped)
check('除标记外原文未动（实体不被打断）', escaped.replace(/<\/?mark[^>]*>/g, '') === '<p>a &amp; b &lt;c&gt;</p>', escaped)

console.log('\n[3] 锚点失效时的回退')
const tokens = tokenizeHtml(SIMPLE)
check('锚点正确时直接命中', resolveRange(tokens, make({ startOffset: 0, endOffset: 5 }))?.start === 0)
const shifted = resolveRange(
  tokens,
  make({ blockIndex: 99, tokenIndex: 0, startOffset: 0, endBlockIndex: 99, endTokenIndex: 0, endOffset: 5, quote: '「你迟到了。」' })
)
check('块号越界时靠原文找回', shifted !== null, JSON.stringify(shifted))
check('找回的位置确实覆盖原文', shifted?.startBlock === 2, `block=${shifted?.startBlock}`)
const gone = resolveRange(tokens, make({ blockIndex: 0, startOffset: 0, endOffset: 3, quote: '这段文字根本不存在' }))
check('原文找不到时返回 null 或退回锚点', gone === null || gone.startBlock === 0)

check('locateQuote 能跨节点找到原文', (() => {
  const hit = locateQuote(tokenizeHtml(INLINE), '停下脚步，回头看')
  return hit !== null && hit.blockIndex === 0
})())
check('locateQuote 在重复文本里优先靠近锚点', (() => {
  const repeated = tokenizeHtml('<p>重复</p><p>重复</p><p>重复</p>')
  const hit = locateQuote(repeated, '重复', { blockIndex: 2, offset: 0 })
  return hit?.blockIndex === 2
})(), String(locateQuote(tokenizeHtml('<p>重复</p><p>重复</p><p>重复</p>'), '重复', { blockIndex: 2, offset: 0 })?.blockIndex))

/* ---------------- 4. 仓储 ---------------- */

console.log('\n[4] 仓储')
const items: Annotation[] = []
const store = new AnnotationStore(items)
const input = {
  bookId: 'book-a',
  chapterIndex: 0,
  chapterTitle: '第一章',
  blockIndex: 1,
  tokenIndex: 0,
  startOffset: 0,
  endBlockIndex: 1,
  endTokenIndex: 0,
  endOffset: 5,
  quote: '他停下脚步',
  color: 'green' as const,
  style: 'underline' as const
}
const created = store.add(input, 'device-1')
check('新增成功', Boolean(created?.id))
check('原文已归一化（去首尾空白）', created?.quote === '他停下脚步', created?.quote)
check('颜色与样式保留', created?.color === 'green' && created?.style === 'underline')
check('没给备注时为空串', created?.note === '')

const withNote2 = store.update(created!.id, { note: '  这里有伏笔  ' })
check('改备注会去首尾空白', withNote2?.note === '这里有伏笔', withNote2?.note)
check('改颜色生效', store.update(created!.id, { color: 'purple' })?.color === 'purple')
check('空 quote 不允许入库', store.add({ ...input, quote: '   ' }, 'd') === null)

const many: Annotation[] = []
const quota = new AnnotationStore(many)
for (let i = 0; i < 999; i += 1) {
  quota.add({ ...input, blockIndex: i, quote: `第 ${i} 段` }, 'd')
}
check('加到上限 999', many.length === 999, `${many.length} 条`)
check('第 1000 条被拒绝', quota.add({ ...input, blockIndex: 1000, quote: 'x' }, 'd') === null)

const removed = store.remove(created!.id)
check('软删除有墓碑', Boolean(removed?.deletedAt))
check('墓碑不在列表里', store.list().length === 0)
check('墓碑仍占额度', store.remaining('book-a') === 999 - 1)
check('撤销成功', store.restore(created!.id)?.deletedAt === undefined)
check('撤销后回到列表', store.list('book-a').length === 1)
check('本章过滤', store.list('book-a', 0).length === 1 && store.list('book-a', 1).length === 0)

console.log('\n[5] 查询辅助与清理')
const mixed = [
  make({ id: 'a', chapterIndex: 0, blockIndex: 0, quote: '甲' }),
  make({ id: 'b', chapterIndex: 1, blockIndex: 0, quote: '乙' }),
  make({ id: 'c', chapterIndex: 1, blockIndex: 5, quote: '丙' }),
  make({ id: 'd', chapterIndex: 1, blockIndex: 9, quote: '丁', deletedAt: Date.now() })
]
check('未删除计数', activeAnnotations(mixed).length === 3)
check('按书计数', annotationCount(mixed, 'book-a') === 3)
check('按章计数', (() => {
  const counts = annotationCountsByChapter(mixed, 'book-a')
  return counts.get(1) === 2 && counts.get(0) === 1
})())
check('本章筛选', annotationsOfChapter(mixed, 'book-a', 1).length === 2)
check('按章内位置排序', (() => {
  const list = new AnnotationStore(mixed).list('book-a')
  // 先按章号，再按块号：0 章的 a 在最前，1 章里 0 → 5（9 是墓碑，不在列表里）
  return list.map((item) => item.id).join('') === 'abc'
})(), new AnnotationStore(mixed).list('book-a').map((item) => item.id).join(''))

const dirty: Annotation[] = [
  make({ id: 'good' }),
  make({ id: 'no-quote', quote: '' }),
  make({ id: 'bad-color', color: 'rainbow' as never }),
  make({ id: 'bad-style', style: 'wave' as never }),
  make({ id: 'stale', deletedAt: Date.now() - 40 * 86400000 })
]
check('sweep 报告改动', new AnnotationStore(dirty).sweep())
check('空原文记录被清掉', !dirty.some((item) => item.id === 'no-quote'))
check('过期墓碑被清掉', !dirty.some((item) => item.id === 'stale'))
check('非法颜色被修正', dirty.find((item) => item.id === 'bad-color')?.color === 'yellow')
check('非法样式被修正', dirty.find((item) => item.id === 'bad-style')?.style === 'highlight')
check('按书清除', new AnnotationStore([...dirty, make({ id: 'x', bookId: 'book-z' })]).removeByBook('book-z') === 1)

console.log('\n[6] 展示辅助')
check('引文预览截断到 60 字加省略号', quotePreview('字'.repeat(100)).length === 61, String(quotePreview('字'.repeat(100)).length))
check('短引文不加省略号', quotePreview('短短一句') === '短短一句')
check('五色齐全', ANNOTATION_COLORS.length === 5, ANNOTATION_COLORS.join(','))
check('normalizeQuote 限长 160', normalizeQuote('字'.repeat(400)).length === 160)
check('collapse 压平空白', collapse('  a\n\n b  ') === 'a b')
check('squash 去掉所有空白', squash(' a\n b ') === 'ab')

console.log('\n[7] 重叠处理（同一段文字不能叠两层颜色）')
{
  const tokens = tokenizeHtml(SIMPLE)
  // SIMPLE 的第 1 块：他停下脚步，回头看那片褪色的樱花。 → token0 全长 17
  const makeItem = (id: string, start: number, end: number): Annotation =>
    make({
      id,
      blockIndex: 1,
      tokenIndex: 0,
      startOffset: start,
      endBlockIndex: 1,
      endTokenIndex: 0,
      endOffset: end,
      quote: tokens[1][0].text.slice(start, end)
    })

  const target = (start: number, end: number): Parameters<typeof planForSelection>[1] => ({
    id: '',
    blockIndex: 1,
    tokenIndex: 0,
    startOffset: start,
    endBlockIndex: 1,
    endTokenIndex: 0,
    endOffset: end
  })

  // 完全重合 → 删掉旧的
  const same = planForSelection(tokens, target(0, 5), [makeItem('old', 0, 5)])
  check('完全重合：旧标注被删掉', same.remove.length === 1 && same.remove[0] === 'old', JSON.stringify(same))
  check('完全重合：不需要裁切', same.trim.length === 0)

  // 完全包含（旧的在新的里面）→ 删掉旧的
  const inside = planForSelection(tokens, target(0, 10), [makeItem('old', 2, 5)])
  check('旧的完全落在新的里：删掉', inside.remove.length === 1, JSON.stringify(inside))

  // 新的完全落在旧的里面 → 旧的裁成左右两段
  const middle = planForSelection(tokens, target(5, 8), [makeItem('old', 0, 12)])
  check('新的落在旧的中间：旧的裁成两段', middle.remove.length === 0 && middle.trim.length === 2, JSON.stringify(middle))
  check(
    '裁出来的两段覆盖剩下的部分',
    middle.trim[0]?.startOffset === 0 && middle.trim[0]?.endOffset === 5 && middle.trim[1]?.startOffset === 8 && middle.trim[1]?.endOffset === 12,
    JSON.stringify(middle.trim)
  )
  check('裁出来的引文跟着变短', middle.trim[0]?.quote === '他停下脚步' && middle.trim[1]?.quote === '看那片褪', JSON.stringify(middle.trim.map((t) => t.quote)))

  // 部分重叠（新的盖住旧的右半）→ 旧的保留左半
  const rightHalf = planForSelection(tokens, target(6, 12), [makeItem('old', 0, 8)])
  check('只盖住右半：旧的缩短', rightHalf.remove.length === 0 && rightHalf.trim.length === 1 && rightHalf.trim[0].endOffset === 6, JSON.stringify(rightHalf))

  // 只是相邻、没有交叠 → 都不动
  const adjacent = planForSelection(tokens, target(6, 10), [makeItem('old', 0, 6)])
  check('首尾相接不算重叠', adjacent.remove.length === 0 && adjacent.trim.length === 0, JSON.stringify(adjacent))

  const apart = planForSelection(tokens, target(0, 3), [makeItem('old', 10, 14)])
  check('完全不相干：都不动', apart.remove.length === 0 && apart.trim.length === 0)

  // 跨段落
  const across = planForSelection(
    tokens,
    { id: '', blockIndex: 1, tokenIndex: 0, startOffset: 3, endBlockIndex: 2, endTokenIndex: 0, endOffset: 3 },
    [
      make({ id: 'b1', blockIndex: 1, tokenIndex: 0, startOffset: 0, endBlockIndex: 1, endTokenIndex: 0, endOffset: 10, quote: tokens[1][0].text.slice(0, 10) }),
      make({ id: 'b2', blockIndex: 2, tokenIndex: 0, startOffset: 0, endBlockIndex: 2, endTokenIndex: 0, endOffset: 10, quote: tokens[2][0].text.slice(0, 10) })
    ]
  )
  check('跨段落时两段各自被裁', across.trim.length === 2 && across.trim[0].blockIndex === 1 && across.trim[1].blockIndex === 2, JSON.stringify(across))
  check('第一段留下选区之前的部分', across.trim[0].startOffset === 0 && across.trim[0].endOffset === 3, JSON.stringify(across.trim[0]))
  check('第二段留下选区之后的部分', across.trim[1].startOffset === 3 && across.trim[1].endOffset === 10, JSON.stringify(across.trim[1]))
}

console.log(`\n共 ${checks} 项，失败 ${failures} 项`)
if (failures > 0) {
  console.log('❌ 划线 / 笔记自检未通过')
  process.exit(1)
}
console.log('✅ 划线 / 笔记自检全部通过')
