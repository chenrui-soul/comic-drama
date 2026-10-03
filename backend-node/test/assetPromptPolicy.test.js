const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PRESET_VALUES, resolveStylePreset } = require('../src/constants/generationStylePresets');
const policy = require('../src/services/assetPromptPolicy');

test('all stock styles have render-only asset definitions; legacy metadata resolves too', () => {
  for (const key of PRESET_VALUES) {
    assert.ok(policy.renderOnly(key), key);
    const preset = resolveStylePreset(key);
    assert.deepEqual(policy.renderOnly(preset.zh), policy.renderOnly(key));
  }
  const preset = resolveStylePreset('v1-oriental-xuanhuan');
  const cfg = policy.mergeAssetStyle({}, { style: 'v1-oriental-xuanhuan', metadata: { style_prompt_zh: preset.zh, style_prompt_en: preset.en } });
  assert.doesNotMatch(JSON.stringify(cfg), /群山|宫阙|神像|waterfall|palace|mountain/i);
});
test('custom styles and valid motifs on the asset itself are never stripped', () => {
  const text = '一根刻有群山和宫殿图案的针，水墨渲染';
  const cfg = policy.mergeAssetStyle({}, { style: 'custom', metadata: { style_prompt_zh: text } });
  assert.equal(cfg.style.default_style_zh, text);
  assert.equal(policy.renderOnly(text), null);
});
