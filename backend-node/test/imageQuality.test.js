const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeImageQuality } = require('../src/services/imageClient');

describe('normalizeImageQuality', () => {
  it('maps legacy standard to high for GPT image models', () => {
    assert.equal(normalizeImageQuality('standard', 'gpt-image-2', 'openai'), 'high');
  });

  it('maps auto to high for GPT image models', () => {
    assert.equal(normalizeImageQuality('auto', 'gpt-image-2', 'openai'), 'high');
  });

  it('keeps supported GPT image quality values', () => {
    assert.equal(normalizeImageQuality('low', 'gpt-image-2', 'openai'), 'low');
    assert.equal(normalizeImageQuality('medium', 'gpt-image-2', 'openai'), 'medium');
    assert.equal(normalizeImageQuality('high', 'gpt-image-2', 'openai'), 'high');
  });

  it('does not send OpenAI quality to non-OpenAI image protocols', () => {
    assert.equal(normalizeImageQuality('standard', 'doubao-seedream-4-5', 'volcengine'), null);
    assert.equal(normalizeImageQuality('high', 'nano-banana-pro', 'nano_banana'), null);
    assert.equal(normalizeImageQuality('high', 'midjourney', 'openai'), null);
    assert.equal(normalizeImageQuality('high', 'unknown-image-model', 'openai'), null);
  });

  it('keeps DALL-E standard compatibility', () => {
    assert.equal(normalizeImageQuality('standard', 'dall-e-3', 'openai'), 'standard');
    assert.equal(normalizeImageQuality('high', 'dall-e-3', 'openai'), null);
  });
});
