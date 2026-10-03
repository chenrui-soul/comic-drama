import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeScriptFile, inspectScript, prepareImportRows } from '../src/utils/scriptImport.js'

test('Markdown script stays one episode with four scenes, preserving every character', () => {
  const text = '\uFEFF\r\n## 第八集 亲子鉴定\r\n\r\n### 8-1 车内 日 内\r\n【字幕：第二天上午】\r\n**甲**\r\n停一下。\r\n### 8-2 大楼外 日 外\r\n△ 开门。\r\n### 8-3 等候区 日 内\r\n【报告特写】\r\n### 8-4 接待室 日 内\r\n**第八集完**\r\n  '
  const report = inspectScript(text)
  assert.equal(report.episodes.length, 1)
  assert.equal(report.episodes[0].title, '第八集 亲子鉴定')
  assert.equal(report.episodes[0].source_number, 8)
  assert.equal(report.episodes[0].scenes.length, 4)
  assert.equal(report.episodes[0].script_content, text)
  assert.equal(report.originalLength, report.importedLength)
})

test('multiple episodes preserve preamble, all whitespace, short content and CRLF', () => {
  const text = '作者说明\r\n\r\n## 第一集 起点\r\n甲：嗯。\r\n\r\n【第二集】\r\n乙：好。 \r\n'
  const report = inspectScript(text)
  assert.equal(report.episodes.length, 2)
  assert.equal(report.episodes.map(e => e.script_content).join(''), text)
  assert.ok(report.warnings[0].includes('之前'))
  assert.deepEqual(report.episodes.map(e => e.source_number), [1, 2])
})

test('end markers, scene directions and chapters within episodes are not new episodes', () => {
  const report = inspectScript('第八集 标题\n第1章 片内文字\n【报告特写】\n「旁白」\n**第八集完**\n第八集结束。\n第九集 后续\n正文')
  assert.equal(report.episodes.length, 2)
})

test('unknown headings fallback without losing content; single mode never splits', () => {
  const text = '序言\n一个没有集标题的故事。\n'
  assert.equal(inspectScript(text, { fileName: '短片.txt' }).episodes[0].title, '短片')
  assert.equal(inspectScript(text).episodes[0].script_content, text)
  assert.equal(inspectScript('第一集\n甲\n第二集\n乙', { mode: 'single' }).episodes.length, 1)
})

test('advanced chapter grouping keeps the source contiguous including preamble', () => {
  const text = '\n前言\n第1章 起\n正文1\r\n第2章 承\n正文2\n第3章 续\n正文3  '
  const report = inspectScript(text, { mode: 'custom', pattern: '^第[0-9]+章', groupSize: 2 })
  assert.equal(report.episodes.length, 2)
  assert.equal(report.episodes.map(e => e.script_content).join(''), text)
  assert.throws(() => inspectScript(text, { mode: 'custom', pattern: '[' }))
  assert.throws(() => inspectScript(text, { mode: 'custom', pattern: '^不会匹配$' }))
})

test('numbering is explicit; conflicts, duplicates and unknown source numbers cannot overwrite', () => {
  const report = inspectScript('第八集 标题\n正文\n第九集 后续\n正文')
  assert.deepEqual(prepareImportRows(report, { numbering: 'source' }).map(e => e.episode_number), [8, 9])
  assert.deepEqual(prepareImportRows(report, { start: 12 }).map(e => e.episode_number), [12, 13])
  assert.throws(() => prepareImportRows(report, { numbering: 'source', existingNumbers: [8] }), /已存在/)
  assert.throws(() => prepareImportRows(inspectScript('第八集 A\n正文\n第八集 B\n正文'), { numbering: 'source' }), /重复/)
  assert.throws(() => prepareImportRows(inspectScript('无标题'), { numbering: 'source' }), /不完整/)
})

test('Chinese and full-width numbers are read correctly', () => {
  const r = inspectScript('第十二集\n甲\n第两百零三集\n乙\n第３０集\n丙')
  assert.deepEqual(r.episodes.map(e => e.source_number), [12, 203, 30])
})

test('strict decoding preserves BOM and rejects malformed UTF-8; GBK is explicit', () => {
  const text = '\uFEFF## 第八集\r\n正文'
  assert.equal(decodeScriptFile(new TextEncoder().encode(text)).text, text)
  assert.throws(() => decodeScriptFile(Uint8Array.from([0xff, 0xfe, 0xff])), /编码/)
  assert.throws(() => decodeScriptFile(Uint8Array.from([0xc4, 0xe3])), /编码/)
  assert.equal(decodeScriptFile(Uint8Array.from([0xc4, 0xe3]), 'gb18030').text, '你')
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('第八集\r\n正文', 'utf16le')])
  assert.equal(decodeScriptFile(utf16).text, '\uFEFF第八集\r\n正文')
})
