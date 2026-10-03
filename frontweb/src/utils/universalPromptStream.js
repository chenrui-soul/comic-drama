import { apiFetch } from './apiFetch.js'

export function postUniversalSegmentNdjsonStream(url, body, onDelta) {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body || {}),
  }).then(res => readUniversalPromptStream(res, onDelta))
}

// Streaming fragments are a preview; only a validated done event is a saved result.
export async function readUniversalPromptStream(res, onDelta) {
  if (!res.ok) {
    let message = `请求失败 (${res.status})`
    try { const data = await res.json(); message = data?.error?.message || message } catch (_) {}
    const error = new Error(message); error.status = res.status; throw error
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('浏览器不支持流式读取')
  const decoder = new TextDecoder()
  let buffer = '', result = null
  function accept(line) {
    if (!line.trim()) return
    let item
    try { item = JSON.parse(line) } catch { throw new Error('润色响应格式损坏，原文已保留') }
    if (item.type === 'error') { const error = new Error(item.message || '润色失败'); error.status = item.status; throw error }
    if (item.type === 'reset') onDelta?.('', { reset: true, attempt: item.attempt, message: item.message || '' })
    if (item.type === 'delta') onDelta?.(String(item.text || ''), { reset: false, type: 'delta' })
    if (item.type === 'done') result = item
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) { buffer += decoder.decode(); break }
      buffer += decoder.decode(value, { stream: true })
      let end
      while ((end = buffer.indexOf('\n')) >= 0) { accept(buffer.slice(0, end)); buffer = buffer.slice(end + 1) }
    }
    accept(buffer)
    if (!result?.universal_segment_text?.trim()) throw new Error('润色响应中断，未收到校验完成结果；原文已保留，请补跑')
    return result
  } finally { reader.releaseLock() }
}
