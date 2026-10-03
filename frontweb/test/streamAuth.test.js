import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFetch } from '../src/utils/apiFetch.js'
import { saveAuthSession, clearAuthSession } from '../src/utils/auth.js'
import { postUniversalSegmentNdjsonStream } from '../src/utils/universalPromptStream.js'

function storage(t) {
  const values = new Map()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  })
}

test('stream polish sends the current workspace session and preserves NDJSON progress', async t => {
  storage(t)
  const received = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    received.push(options.headers.get('Authorization'))
    assert.equal(url, '/api/v1/storyboards/1/universal-segment-polish-stream')
    assert.equal(options.headers.get('Accept'), 'application/x-ndjson')
    assert.equal(options.headers.get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(options.body), { draft_universal_segment_text: '原文' })
    return new Response('{"type":"delta","text":"润色"}\n{"type":"done","universal_segment_text":"润色结果"}\n')
  })
  const deltas = []
  for (const token of ['workspace-a-session', 'workspace-b-session']) {
    saveAuthSession({ token })
    const result = await postUniversalSegmentNdjsonStream('/api/v1/storyboards/1/universal-segment-polish-stream',
      { draft_universal_segment_text: '原文' }, delta => deltas.push(delta))
    assert.equal(result.universal_segment_text, '润色结果')
  }
  assert.deepEqual(received, ['Bearer workspace-a-session', 'Bearer workspace-b-session'])
  assert.deepEqual(deltas, ['润色', '润色'])
})

test('logout removes stale credentials; unauthorized stream retains its error status', async t => {
  storage(t)
  saveAuthSession({ token: 'old-session' })
  clearAuthSession()
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.has('Authorization'), false)
    return new Response(JSON.stringify({ error: { message: '登录已失效，请重新登录' } }), { status: 401 })
  })
  await apiFetch('/api/v1/audio/extract', { headers: { Authorization: 'Bearer stale-session' } })
  await assert.rejects(postUniversalSegmentNdjsonStream('/api/v1/storyboards/1/universal-segment-polish-stream', {}),
    error => error.status === 401 && /登录已失效/.test(error.message))
})

test('audio requests preserve body and abort signal while adding current authentication', async t => {
  storage(t)
  saveAuthSession({ token: 'audio-session' })
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.get('Authorization'), 'Bearer audio-session')
    assert.equal(options.body, '{"storyboard_id":1}')
    assert.equal(options.signal, controller.signal)
    return new Response('{}')
  })
  await apiFetch('/api/v1/audio/extract', { method: 'POST', body: '{"storyboard_id":1}', signal: controller.signal })
  assert.throws(() => apiFetch('https://provider.invalid/api/v1/test'), /仅支持本站/)
})
