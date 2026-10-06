/**
 * 书名解析：识别卷号并把同系列的书归到一组。
 * 真实书库里的命名非常杂，例如：
 *   安达与岛村 1 / 安达与岛村11 / 安达与岛村 10 试读版
 *   安达与岛村-第八卷-迷糊轻小说 / 安達としまむらSS (電撃文庫)
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

/** 中文数字转阿拉伯数字，支持 一 ~ 九十九 与纯阿拉伯数字 */
export function parseVolumeNumber(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  if (/^\d{1,3}$/.test(text)) {
    const value = Number(text)
    return value > 0 ? value : null
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
  return section > 0 ? section : null
}

/**
 * 卷号匹配规则，按优先级排列。
 * group=0 表示整个匹配都是卷号标记（要一并删除），
 * group=1 表示只有捕获到的数字是卷号（前缀字符必须保留）。
 */
const VOLUME_PATTERNS: { re: RegExp; group: 0 | 1 }[] = [
  // 第八卷 / 第 8 册 / 第9集 / 第10部
  { re: /第\s*([0-9]{1,3}|[零〇一二两三四五六七八九十]{1,4})\s*[卷册集部]/, group: 0 },
  // Vol.3 / Volume 3
  { re: /(?:^|[\s\-–—_·(（[])(?:vol\.?|volume)\s*([0-9]{1,3})(?=$|[\s\-–—_·)）\]])/i, group: 0 },
  // 结尾的阿拉伯数字，允许中间有空格/连字符，允许「试读版」等尾缀：安达与岛村11 / 某书 10 试读版
  {
    re: /(?:^|[\s\-–—_·]|[\u4e00-\u9fff])([0-9]{1,3})(?:\s*(?:试读版|試讀版|修订版|修訂版|精排版|完结版))?\s*$/,
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
  return result
}

export interface VolumeInfo {
  /** 卷号，例如 "8"（去掉前导零）；识别不到为 null */
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
    const parsed = parseVolumeNumber(match[1] ?? '')
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
    return { volume: String(parsed), seriesKey: seriesKey || null }
  }

  return { volume: null, seriesKey: null }
}

export { stripNoise }
