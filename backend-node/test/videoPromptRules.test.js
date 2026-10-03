const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const rules = require('../src/services/videoPromptRules');
const compiler = require('../src/services/customVideoPrompt');

test('imports a skill archive as a safe, versioned rule pack', () => {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from('---\ndisplay_name: 我的规则\nversion: 2.1\n---\n# 规则'));
  zip.addFile('rules/prompt_compilation.yaml', Buffer.from('rules:\n  keep: true'));
  const pack = rules.readUpload(zip.toBuffer(), 'mine.zip');
  assert.equal(pack.name, '我的规则');
  assert.equal(pack.version, '2.1');
  assert.deepEqual([...pack.active_paths].sort(), ['SKILL.md', 'rules/prompt_compilation.yaml'].sort());
  assert.match(rules.systemPrompt(pack), /平台接入约定/);
});

test('rejects unsafe archive paths and invalid image bindings', () => {
  assert.throws(() => rules.normalizePack({ files: [{ path: '../SKILL.md', content: '# x' }] }), /不安全/);
  assert.deepEqual(compiler.validatePrompt('绑定资产：@图片2 角色\n[0-5秒 | 镜头1] 动作', 5, [{ tag: '@图片1' }], { timelineRequired: true }), ['@图片2 没有对应的本次参考图']);
  assert.deepEqual(compiler.validatePrompt('[0-4秒 | 镜头1] 动作', 5, [], { timelineRequired: true }), ['时间轴结束于 4 秒，与提交时长 5 秒不一致']);
});
