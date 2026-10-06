import { XMLParser } from 'fast-xml-parser'
import { strFromU8, unzipSync } from 'fflate'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import type { TocNode } from '../shared/types'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseAttributeValue: false,
  textNodeName: '#text',
  htmlEntities: true
})

function arr<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(text).join(' ')
  const obj = value as Record<string, unknown>
  if (typeof obj['#text'] === 'string') return obj['#text']
  if (typeof obj['#text'] === 'number') return String(obj['#text'])
  return ''
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface EpubMeta {
  title: string
  author: string
  coverData: Uint8Array | null
  coverExt: string | null
  /** 相对 OPF 目录的章节路径（posix 分隔符），按 spine 顺序 */
  chapterHrefs: string[]
  opfPath: string
  opfDir: string
  toc: TocNode[]
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'])

/** 读取 EPUB 元数据、封面、spine 与目录（只解压需要的条目） */
export async function readEpubMeta(filePath: string): Promise<EpubMeta> {
  const buf = new Uint8Array(await readFile(filePath))

  const containerRaw = unzipSync(buf, { filter: (f) => f.name === 'META-INF/container.xml' })
  const containerXml = containerRaw['META-INF/container.xml']
  if (!containerXml) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')
  const container = parser.parse(strFromU8(containerXml))
  const rootfile = arr(container?.container?.rootfiles?.rootfile)[0]
  const opfPath = String(rootfile?.['@_full-path'] ?? '')
  if (!opfPath) throw new Error('不是有效的 EPUB：未找到 OPF 路径')

  const opfRaw = unzipSync(buf, { filter: (f) => f.name === opfPath })[opfPath]
  if (!opfRaw) throw new Error('不是有效的 EPUB：未找到 OPF 文件')
  const opf = parser.parse(strFromU8(opfRaw))
  const pkg = opf?.package ?? {}
  const metadata = pkg.metadata ?? {}

  const title = text(metadata.title).trim()
  const author = text(metadata.creator).trim()
  const opfDir = posix.dirname(opfPath) === '.' ? '' : posix.dirname(opfPath)

  const items = arr(pkg.manifest?.item).map((it: any) => ({
    id: String(it['@_id'] ?? ''),
    href: String(it['@_href'] ?? ''),
    mediaType: String(it['@_media-type'] ?? ''),
    properties: String(it['@_properties'] ?? '')
  }))
  const byId = new Map(items.map((i) => [i.id, i]))
  /** 归一化为「相对 OPF 目录」的路径 */
  const relHref = (href: string): string => {
    let decoded = href
    try {
      decoded = decodeURIComponent(href)
    } catch {
      /* 保留原值 */
    }
    return posix.normalize(decoded).replace(/^\.\//, '')
  }
  /** 归一化为 zip 内的完整路径 */
  const zipPath = (href: string): string => (opfDir ? posix.join(opfDir, relHref(href)) : relHref(href))

  // 章节顺序（相对 OPF 目录）
  const spineRefs = arr(pkg.spine?.itemref)
    .map((r: any) => byId.get(String(r['@_idref'] ?? '')))
    .filter(Boolean)
  const chapterHrefs = spineRefs.map((i: any) => relHref(i.href))

  // 封面：EPUB3 properties=cover-image > EPUB2 meta[name=cover] > 文件名猜测
  let coverItem = items.find((i) => i.properties.split(/\s+/).includes('cover-image'))
  if (!coverItem) {
    const metaCover = arr(metadata.meta).find((m: any) => String(m['@_name'] ?? '').toLowerCase() === 'cover')
    const coverId = metaCover ? String(metaCover['@_content'] ?? '') : ''
    if (coverId) coverItem = byId.get(coverId)
  }
  if (!coverItem) {
    coverItem = items.find((i) => IMAGE_EXT.has(extname(i.href).toLowerCase()) && /cover/i.test(i.href))
  }

  let coverData: Uint8Array | null = null
  let coverExt: string | null = null
  if (coverItem) {
    const coverPath = zipPath(coverItem.href)
    const got = unzipSync(buf, { filter: (f) => f.name === coverPath })[coverPath]
    if (got && got.byteLength > 0) {
      coverData = got
      coverExt = extname(coverPath).toLowerCase() || '.jpg'
    }
  }

  // 目录：EPUB3 nav > EPUB2 ncx
  let toc: TocNode[] = []
  const navItem = items.find((i) => i.properties.split(/\s+/).includes('nav'))
  if (navItem) {
    const navPath = zipPath(navItem.href)
    const navRaw = unzipSync(buf, { filter: (f) => f.name === navPath })[navPath]
    if (navRaw) {
      try {
        toc = parseNavHtml(strFromU8(navRaw), posix.dirname(navPath), opfDir)
      } catch {
        toc = []
      }
    }
  }
  if (toc.length === 0) {
    const ncxId = String(pkg.spine?.['@_toc'] ?? '')
    const ncxItem = byId.get(ncxId) ?? items.find((i) => i.mediaType.includes('dtbncx'))
    if (ncxItem) {
      const ncxPath = zipPath(ncxItem.href)
      const ncxRaw = unzipSync(buf, { filter: (f) => f.name === ncxPath })[ncxPath]
      if (ncxRaw) {
        try {
          toc = parseNcx(strFromU8(ncxRaw), posix.dirname(ncxPath), opfDir)
        } catch {
          toc = []
        }
      }
    }
  }

  return { title, author, coverData, coverExt, chapterHrefs, opfPath, opfDir, toc }
}

/** 解析 EPUB3 nav.xhtml 目录（正则实现，对非严格 XHTML 更宽容） */
function parseNavHtml(html: string, navDir: string, opfDir: string): TocNode[] {
  const navMatch =
    html.match(/<nav[^>]*\btype\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav>/i) ??
    html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i)
  const scope = navMatch ? navMatch[1] : html

  const roots: TocNode[] = []
  const stack: TocNode[] = []
  const re = /<ol\b[^>]*>|<\/ol>|<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(scope)) !== null) {
    const token = m[0]
    if (/^<ol/i.test(token)) {
      stack.push({ label: '', href: '', children: [] })
      continue
    }
    if (/^<\/ol/i.test(token)) {
      const node = stack.pop()
      if (!node) continue
      if (stack.length > 0) stack[stack.length - 1].children.push(node)
      else roots.push(...node.children)
      continue
    }
    const href = resolveNavHref(m[1] ?? '', navDir, opfDir)
    const node: TocNode = { label: stripTags(m[2] ?? ''), href, children: [] }
    if (stack.length > 0) stack[stack.length - 1].children.push(node)
    else roots.push(node)
  }
  return roots
}

/** 解析 EPUB2 toc.ncx */
function parseNcx(xml: string, ncxDir: string, opfDir: string): TocNode[] {
  const ncx = parser.parse(xml)
  const walk = (point: any): TocNode => ({
    label: text(point?.navLabel?.text).trim(),
    href: resolveNavHref(String(point?.content?.['@_src'] ?? ''), ncxDir, opfDir),
    children: arr(point?.navPoint).map(walk)
  })
  return arr(ncx?.ncx?.navMap?.navPoint).map(walk)
}

/** 目录中的 href 统一换算成「相对 OPF 目录」的路径，便于与 spine 对齐 */
function resolveNavHref(href: string, baseDir: string, opfDir: string): string {
  if (!href) return ''
  const pathPart = href.split('#')[0]
  if (!pathPart) return href
  let decoded = pathPart
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    /* 保留原值 */
  }
  const abs = posix.normalize(posix.join(baseDir, decoded))
  return posix.relative(opfDir, abs)
}

/** 把书籍完整解压到缓存目录，返回缓存根目录 */
export async function extractEpub(filePath: string, destDir: string): Promise<void> {
  const buf = new Uint8Array(await readFile(filePath))
  const entries = unzipSync(buf)
  for (const [name, data] of Object.entries(entries)) {
    if (!data || name.endsWith('/')) continue
    const target = safeJoin(destDir, name)
    if (!target) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
  }
}

/** 防目录穿越 */
function safeJoin(root: string, name: string): string | null {
  const target = resolve(root, name.split('/').join(sep))
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null
  return target
}

export interface ChapterText {
  html: string
  title: string
}

/** 读取并净化单章正文，图片改写为 dsh:// 协议地址 */
export async function readChapter(
  cacheDir: string,
  opfDir: string,
  href: string,
  toUrl: (absPath: string) => string
): Promise<ChapterText> {
  const abs = safeJoin(cacheDir, opfDir ? posix.join(opfDir, href) : href)
  if (!abs) throw new Error('章节路径非法')
  const raw = await readFile(abs, 'utf8')
  const baseAbs = dirname(abs)
  const opfAbs = opfDir ? join(cacheDir, opfDir.split('/').join(sep)) : cacheDir
  return { html: sanitizeChapter(raw, baseAbs, opfAbs, toUrl), title: extractTitle(raw) }
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? stripTags(m[1]) : ''
}

/** 净化正文：去掉脚本/样式/事件属性，重写资源与内链 */
export function sanitizeChapter(
  raw: string,
  baseAbs: string,
  opfAbs: string,
  toUrl: (absPath: string) => string
): string {
  let html = raw
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (body) html = body[1]
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(/<(script|style|link|meta|title|base|iframe|object|embed|audio|video)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  html = html.replace(/<\/?(script|style|link|meta|title|base|iframe|object|embed|audio|video|html|head|body)\b[^>]*>/gi, '')
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  html = html.replace(
    /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (_m, attr: string, dq?: string, sq?: string) => {
      const value = dq ?? sq ?? ''
      const next = rewriteUrl(attr.toLowerCase(), value, baseAbs, opfAbs, toUrl)
      if (!next) return ''
      return ` ${attr}="${next.replace(/"/g, '&quot;')}"`
    }
  )
  html = html.replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy"')
  return html.trim()
}

function rewriteUrl(
  attr: string,
  value: string,
  baseAbs: string,
  opfAbs: string,
  toUrl: (absPath: string) => string
): string {
  const raw = value.trim()
  if (!raw) return ''
  if (/^(https?:|data:|mailto:|tel:)/i.test(raw)) return raw
  if (/^javascript:/i.test(raw)) return ''
  if (raw.startsWith('#')) return raw

  const hashIndex = raw.indexOf('#')
  const pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const frag = hashIndex >= 0 ? raw.slice(hashIndex) : ''
  if (!pathPart) return raw

  let decoded = pathPart
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    /* 保留原值 */
  }
  const abs = resolve(baseAbs, decoded.split('/').join(sep))
  const ext = extname(abs).toLowerCase()

  if (attr === 'src') {
    return IMAGE_EXT.has(ext) ? toUrl(abs) : ''
  }
  // 文档内链：转成可被渲染进程识别的锚点
  const rel = relative(opfAbs, abs).split(sep).join('/')
  if (rel.startsWith('..')) return frag || ''
  return `#epub:${encodeURIComponent(rel)}${frag}`
}

export { IMAGE_EXT }
