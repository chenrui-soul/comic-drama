// Import is structural only: every saved body is an untouched slice of the source.
const numberToken = '[0-9０-９零〇一二两三四五六七八九十百千万]+'
const headingRe = new RegExp(`^第\\s*(${numberToken})\\s*([集章回节])(.*)$`)

function displayHeading(line) {
  let value = line.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '')
  value = value.replace(/^\*\*(.*?)\*\*$/, '$1')
  value = value.replace(/^[【《「\[](.+)[】》」\]]$/, '$1').trim()
  return value
}

function numberValue(value) {
  const s = value.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 65296))
  if (/^\d+$/.test(s)) return Number(s)
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units = { 十: 10, 百: 100, 千: 1000 }
  let total = 0, section = 0, digit = 0
  for (const c of s) {
    if (c in digits) digit = digits[c]
    else if (c === '万') { total += (section + digit || 1) * 10000; section = 0; digit = 0 }
    else { section += (digit || 1) * units[c]; digit = 0 }
  }
  return total + section + digit
}

export function decodeScriptFile(buffer, encoding = 'auto') {
  const bytes = new Uint8Array(buffer)
  let chosen = encoding
  if (chosen === 'auto') {
    chosen = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
      : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
  }
  let text
  try { text = new TextDecoder(chosen, { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('无法按所选编码读取。请尝试 GB18030（兼容 GBK），并核对原文预览。') }
  if (text.includes('\uFFFD') || text.includes('\0')) throw new Error('文本存在乱码或空字符，请检查文件编码后重新读取。')
  return { text, encoding: chosen.toUpperCase() }
}

export function inspectScript(text, { mode = 'auto', pattern = '', groupSize = 1, fileName = '未命名剧本' } = {}) {
  if (!text?.trim()) throw new Error('文件内容为空')
  const warnings = []
  let custom
  if (mode === 'custom') {
    try { custom = new RegExp(pattern) } catch { throw new Error('章节正则格式不正确') }
    if (!pattern.trim()) throw new Error('请输入章节正则')
  }
  const headings = []
  let inFence = false
  // Offsets refer to the original string, including CRLF, BOM and leading text.
  for (const match of text.matchAll(/[^\r\n]+|\r\n|[\r\n]/g)) {
    const line = match[0]
    if (/^[\r\n]+$/.test(line)) continue
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence || mode === 'single') continue
    const title = displayHeading(line)
    const found = headingRe.exec(title)
    if (mode === 'custom' ? custom.test(line) : found && !/^第.+[集章回节]\s*(完|终|结束)[。！.!！]*$/.test(title)) {
      headings.push({ start: match.index, title, number: found ? numberValue(found[1]) : null, kind: found?.[2] })
    }
  }
  // Explicit episode headings take precedence over chapters inside an episode.
  const boundaries = mode === 'auto' && headings.some(h => h.kind === '集')
    ? headings.filter(h => h.kind === '集') : headings
  if (!boundaries.length) {
    if (mode === 'custom') throw new Error('未匹配到章节，请调整正则，或选择“整份文件作为一集”。')
    warnings.push('未识别集标题，已按整份文件作为一集；请核对标题和目标集号。')
    boundaries.push({ start: 0, title: fileName.replace(/\.(txt|md)$/i, ''), number: null })
  } else if (text.slice(0, boundaries[0].start).trim()) {
    warnings.push('第一处集标题之前的文字已完整保留在首集，请核对。')
  }
  const size = mode === 'custom' ? Math.max(1, Math.floor(Number(groupSize) || 1)) : 1
  const episodes = []
  for (let i = 0; i < boundaries.length; i += size) {
    const endIndex = Math.min(i + size, boundaries.length)
    const start = i === 0 ? 0 : boundaries[i].start
    const end = endIndex < boundaries.length ? boundaries[endIndex].start : text.length
    const script = text.slice(start, end)
    const scenes = script.split(/\r\n|[\r\n]/).map(displayHeading)
      .filter(line => /^\d+\s*[-－—]\s*\d+(?:\s|[：:、])/.test(line) || /^第[零一二三四五六七八九十\d]+场(?:\s|[：:、])/.test(line))
    episodes.push({ title: endIndex - i === 1 ? boundaries[i].title : `${boundaries[i].title} — ${boundaries[endIndex - 1].title}`,
      source_number: size === 1 ? boundaries[i].number : null, script_content: script, scenes, start, end })
  }
  if (episodes.map(e => e.script_content).join('') !== text) throw new Error('原文一致性检查失败，已阻止导入。')
  return { episodes, warnings, originalLength: text.length, importedLength: episodes.reduce((n, e) => n + e.script_content.length, 0), unchanged: true }
}

export function prepareImportRows(report, { numbering = 'append', start = 1, existingNumbers = [] } = {}) {
  const occupied = new Set(existingNumbers.map(Number))
  return report.episodes.map((episode, index) => {
    const number = numbering === 'source' ? episode.source_number : Number(start) + index
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('原文集号不完整或无效，请选择顺序追加。')
    if (occupied.has(number)) throw new Error(`第 ${number} 集已存在或在文件中重复，请选择顺序追加或检查原文集号。`)
    occupied.add(number)
    return { episode_number: number, title: episode.title, script_content: episode.script_content, description: null, duration: 0 }
  })
}
