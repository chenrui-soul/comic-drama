import { test } from 'node:test'
import assert from 'node:assert/strict'
import { secondsLabel, readPlan, settingsSummary } from '../src/utils/narrativePlanReport.js'
test('missing draft times are uncomputed, never NaN or false zero', () => {
  for (const value of [undefined, null, NaN, Infinity, '30000', -1]) assert.equal(secondsLabel(value), '未计算')
  assert.equal(secondsLabel(30000), '30 秒')
  assert.equal(secondsLabel(0), '0 秒')
})
test('reports distinguish automatic estimates and target mode', () => {
  const text = settingsSummary({ clip_seconds: 30, duration_mode: 'target', storyboard_count_source: 'auto', storyboard_count: 5, total_source: 'auto', total_seconds: 146 })
  assert.match(text, /每段约 30 秒/)
  assert.match(text, /自动（参考 5 段）/)
  assert.match(text, /自动（参考 146 秒）/)
  assert.equal(readPlan('{bad'), null)
  assert.deepEqual(readPlan('{"units":[]}'), { units: [] })
})
