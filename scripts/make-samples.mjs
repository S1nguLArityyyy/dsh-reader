/**
 * 生成用于开发与验收的示例 EPUB（真实 epub 结构，可直接导入 Dsh Reader）。
 * 用法：node scripts/make-samples.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'samples')

/* ---------------- PNG 生成 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function cover(hue) {
  const W = 600
  const H = 900
  return png(W, H, (x, y) => {
    const t = (x / W) * 0.45 + (y / H) * 0.55
    const light = 62 - t * 30
    const band = y > H * 0.62 && y < H * 0.64 ? 18 : 0
    const circle = (x - W * 0.68) ** 2 + (y - H * 0.26) ** 2 < (W * 0.17) ** 2 ? 16 : 0
    const hsl = (h, s, l) => {
      const c = (1 - Math.abs(2 * l - 1)) * s
      const hp = (h % 360) / 60
      const xx = c * (1 - Math.abs((hp % 2) - 1))
      const m = l - c / 2
      let rgb = [0, 0, 0]
      if (hp < 1) rgb = [c, xx, 0]
      else if (hp < 2) rgb = [xx, c, 0]
      else if (hp < 3) rgb = [0, c, xx]
      else if (hp < 4) rgb = [0, xx, c]
      else if (hp < 5) rgb = [xx, 0, c]
      else rgb = [c, 0, xx]
      return rgb.map((v) => Math.round(Math.min(255, Math.max(0, (v + m) * 255 + band + circle))))
    }
    return hsl(hue, 0.42, Math.min(0.9, Math.max(0.12, light / 100)))
  })
}

/* ---------------- ZIP 生成（store 模式） ---------------- */

function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBuf, end])
}

/* ---------------- 内容 ---------------- */

const PARAGRAPHS = [
  '十月的风从窗缝里钻进来，翻动了桌上的书页。他把书按住，就着午后那点发白的光，又读了一页。',
  '街道尽头的梧桐落了一地叶子，踩上去会发出干脆的响声。她走过的时候没有回头，只是把围巾往上拉了拉。',
  '“你总说时间不够。”他说，“可时间从来不欠谁，是我们把它花错了地方。”',
  '窗台上的水仙还没开，叶子却已经绿得发亮。屋子里安静得能听见钟表走动的声音，一格，一格。',
  '那些被搁置的信，最后还是寄了出去。信封上的地址已经模糊，邮差看了很久，还是点点头收下了。',
  '雨下了一整夜。清晨推开窗，空气里全是湿润的土腥味，远处的山像被谁用炭笔重新描过一遍。',
  '她习惯在书的扉页写下日期，再写上一句只有自己看得懂的话。多年以后翻回去，那些句子依然认得她。',
  '列车驶出隧道的那一瞬，光涌进车厢，所有人都下意识地眯起了眼睛。有人笑了一声，很轻。',
  '他忽然想起很多年前的那个夏天，蝉声把午睡割成一段一段，而他们躺在凉席上，讨论着永远不会到来的明天。',
  '故事到这里本该结束。可写字的人还坐在灯下，笔尖悬在纸上，迟迟没有落下最后那一划。'
]

function chapter(title, count, seed) {
  const body = []
  for (let i = 0; i < count; i += 1) {
    body.push(`      <p>${PARAGRAPHS[(seed + i) % PARAGRAPHS.length]}</p>`)
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
  <head>
    <title>${title}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <h2>${title}</h2>
${body.join('\n')}
  </body>
</html>
`
}

function buildEpub({ title, author, uuid, hue, chapterTitles }) {
  const chapters = chapterTitles.map((name, index) => ({
    id: `ch${index + 1}`,
    href: `chapter${index + 1}.xhtml`,
    name
  }))

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
${chapters.map((c) => `    <item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover"/>
${chapters.map((c) => `    <itemref idref="${c.id}"/>`).join('\n')}
  </spine>
</package>
`

  const navItems = chapters
    .map((c) => `        <li><a href="${c.href}">${c.name}</a></li>`)
    .join('\n')

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
${navItems}
      </ol>
    </nav>
  </body>
</html>
`

  const ncxPoints = chapters
    .map(
      (c, index) => `    <navPoint id="np${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${c.name}</text></navLabel>
      <content src="${c.href}"/>
    </navPoint>`
    )
    .join('\n')

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${uuid}"/></head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
${ncxPoints}
  </navMap>
</ncx>
`

  const coverPage = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
  <head><title>封面</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
  <body class="cover"><img src="cover.png" alt="${title}"/></body>
</html>
`

  const css = `body { margin: 0 5%; line-height: 1.75; }
h2 { margin: 1.6em 0 1em; font-size: 1.3em; }
p { margin: 0 0 1em; text-indent: 2em; }
body.cover { margin: 0; text-align: center; }
body.cover img { max-width: 100%; }
`

  return zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/style.css', data: css },
    { name: 'OEBPS/cover.xhtml', data: coverPage },
    { name: 'OEBPS/cover.png', data: cover(hue) },
    ...chapters.map((c, index) => ({
      name: `OEBPS/${c.href}`,
      data: chapter(c.name, 8 + (index % 3) * 3, index * 3)
    }))
  ])
}

const BOOKS = [
  {
    file: '星海拾遗 01.epub',
    title: '星海拾遗 01',
    author: '林晚',
    uuid: '11111111-1111-4111-8111-111111111101',
    hue: 212,
    chapterTitles: ['第一章 潮汐线', '第二章 观测站', '第三章 无人回信', '第四章 归航']
  },
  {
    file: '星海拾遗 02.epub',
    title: '星海拾遗 02',
    author: '林晚',
    uuid: '11111111-1111-4111-8111-111111111102',
    hue: 268,
    chapterTitles: ['第五章 双星', '第六章 静默带', '第七章 旧地图', '第八章 远日点']
  },
  {
    file: '十月书简.epub',
    title: '十月书简',
    author: '沈迟',
    uuid: '11111111-1111-4111-8111-111111111103',
    hue: 25,
    chapterTitles: ['信一 · 立秋', '信二 · 白露', '信三 · 寒露', '信四 · 霜降', '尾聲']
  }
]

await mkdir(outDir, { recursive: true })
for (const book of BOOKS) {
  const buffer = buildEpub(book)
  const target = join(outDir, book.file)
  await writeFile(target, buffer)
  console.log(`[sample] ${target} (${(buffer.length / 1024).toFixed(1)} KB)`)
}
