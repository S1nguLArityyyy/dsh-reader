/**
 * 书名解析：识别卷号并把同系列的书归到一组。
 * 真实书库里的命名非常杂，例如：
 *   安达与岛村 1 / 安达与岛村11 / 安达与岛村 10 试读版
 *   安达与岛村-第八卷-迷糊轻小说 / 安達としまむらSS (電撃文庫)
 *   败北女角太多了！01 / 败北女角太多了！08.5
 *
 * 主进程与渲染进程共用（分组逻辑在渲染端也要跑）。
 */

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

/** 中文数字转阿拉伯数字，支持 一 ~ 九十九；阿拉伯数字原样返回（含小数） */
export function normalizeVolume(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) {
    const value = Number(text)
    return value > 0 ? String(value) : null
  }
  let section = 0
  for (const ch of text) {
    if (ch === '十') {
      section = (section === 0 ? 1 : section) * 10
    } else if (CN_DIGITS[ch] !== undefined) {
      section += CN_DIGITS[ch]
    } else {
      return null
    }
  }
  return section > 0 ? String(section) : null
}

/**
 * 卷号匹配规则，按优先级排列。
 * group=0 表示整个匹配都是卷号标记（要一并删除），
 * group=1 表示只有捕获到的数字是卷号（前缀字符必须保留）。
 * 前缀允许任意非字母数字字符，以便识别「败北女角太多了！01」这类全角标点。
 */
const VOLUME_PATTERNS: { re: RegExp; group: 0 | 1 }[] = [
  // 第八卷 / 第 8 册 / 第9集 / 第10部
  { re: /第\s*([0-9]{1,3}(?:\.[0-9]{1,2})?|[零〇一二两三四五六七八九十]{1,4})\s*[卷册集部]/, group: 0 },
  // Vol.3 / Volume 3
  {
    re: /(?:^|[\s\-–—_·(（\[])(?:vol\.?|volume)\s*([0-9]{1,3}(?:\.[0-9]{1,2})?)(?=$|[\s\-–—_·)）\]])/i,
    group: 0
  },
  // 结尾的阿拉伯数字（支持 08.5 这类小数与全角标点前缀）：败北女角太多了！01 / 某书 10 试读版
  {
    re: /(?:^|[^0-9A-Za-z])([0-9]{1,3}(?:\.[0-9]{1,2})?)(?:\s*(?:试读版|試讀版|修订版|修訂版|精排版|完结版))?\s*$/,
    group: 1
  },
  // 结尾的中文数字：某书 十二
  { re: /(?:^|[\s\-–—_·])([零〇一二两三四五六七八九十]{1,3})\s*$/, group: 1 }
]

/** 书名里的站点 / 版本噪声，归属系列时应当忽略 */
const NOISE_PATTERNS: RegExp[] = [
  /[\s\-–—_·|｜]*(?:迷糊轻小说|哔哩轻小说|轻之国度|轻小说文库|铅笔小说|SF轻小说|esjzone|天使动漫|真白萌|轻书架|次元图书馆)[\s\-–—_·|｜]*$/i,
  /[\s\-–—_·|｜]*(?:贴吧版|贴吧录入|简繁文库|电击文库|電撃文庫|文库版|文庫版|文庫|文库|录入版|扫描版|自制版|精排|重排|epub|epub版)[\s\-–—_·|｜]*$/i,
  /[\s\-–—_·|｜]*(?:试读版|試讀版|修订版|修訂版|完结版|完結版|全集|套装|套裝)[\s\-–—_·|｜]*$/i
]

/** 去掉结尾的括注，例如 (電撃文庫)、【贴吧版】 */
const TRAILING_BRACKET = /[\s\-–—_·]*[（(\[【][^）)\]】]{0,16}[）)\]】]\s*$/

function stripNoise(title: string): string {
  let result = title
  for (let round = 0; round < 6; round += 1) {
    const before = result
    result = result.replace(TRAILING_BRACKET, '')
    for (const pattern of NOISE_PATTERNS) result = result.replace(pattern, '')
    result = result.replace(/[\s\-–—_·|｜]+$/, '').trim()
    if (result === before) break
  }
  // 去掉首尾标点：让「败北女角太多了！」与「败北女角太多了」归到同一系列
  return result
    .replace(/^[\s\-–—_·|｜!！?？.。,，、:：;；'"“”‘’()（）[\]【】《》「」…~～+&]+/, '')
    .replace(/[\s\-–—_·|｜!！?？.。,，、:：;；'"“”‘’…~～+&]+$/, '')
    .trim()
}

/**
 * 模糊归组键：去掉数字、拉丁字母与标点，只保留中日文字符。
 * 用于「文件名里没有卷号，但明显是同一系列」的情况。
 */
export function looseKey(title: string): string {
  return (title ?? '')
    .replace(/[0-9０-９]/g, '')
    .replace(/[A-Za-z]/g, '')
    .replace(/[\s\-–—_·|｜!！?？.。,，、:：;；'"“”‘’()（）[\]【】《》「」…~～+&※★☆]/g, '')
    .trim()
}

export interface VolumeInfo {
  /** 卷号，例如 "8" 或 "8.5"（去掉前导零）；识别不到为 null */
  volume: string | null
  /** 同系列归组键；识别不到卷号时为 null */
  seriesKey: string | null
}

/** 从书名中提取卷号，并给出同系列归组键 */
export function splitVolume(rawTitle: string): VolumeInfo {
  const title = (rawTitle ?? '').trim()
  if (!title) return { volume: null, seriesKey: null }

  for (const { re, group } of VOLUME_PATTERNS) {
    const match = title.match(re)
    if (!match || match.index === undefined) continue
    const parsed = normalizeVolume(match[1] ?? '')
    if (parsed === null) continue

    let withoutVolume: string
    if (group === 0) {
      withoutVolume = `${title.slice(0, match.index)} ${title.slice(match.index + match[0].length)}`
    } else {
      // 只删除卷号本身，保留前缀汉字，例如「安达与岛村11」要留下「村」
      const token = match[1] ?? ''
      const offset = Math.max(0, match[0].indexOf(token))
      const start = match.index + offset
      withoutVolume = `${title.slice(0, start)} ${title.slice(start + token.length)}`
    }

    // 去掉卷号本身，再去掉站点/版本噪声，剩下的作为系列名
    const seriesKey = stripNoise(withoutVolume.replace(/\s+/g, ' '))
    return { volume: parsed, seriesKey: seriesKey || null }
  }

  return { volume: null, seriesKey: null }
}

export { stripNoise }

/**
 * 展示用书名以**文件名**为准（用户明确要求）：
 * EPUB 内部的 dc:title 常常所有卷都写成同一个名字，导致分类时无法区分卷号。
 * 文件名不像书名时（UUID、纯数字、太短）回退到内部书名。
 */
export function titleFromFileName(fileName: string, metaTitle: string): string {
  // 只去掉真正的电子书扩展名：不能用「去掉最后一个点号之后的内容」，
  // 否则「败北女角太多了！08.5」会被截成「…08」。
  const stem = (fileName ?? '')
    .replace(/\.(epub|mobi|azw3?|txt|pdf|cbz|zip|fb2|html?)$/i, '')
    .trim()
  const fallback = (metaTitle ?? '').trim()
  if (!stem) return fallback
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(stem)) return fallback || stem
  if (/^\d+$/.test(stem)) return fallback || stem
  if (stem.length < 2) return fallback || stem
  return stem
}
