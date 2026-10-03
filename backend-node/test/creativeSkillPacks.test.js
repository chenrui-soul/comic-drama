const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const rules = require('../src/services/creativeSkillPacks');

test('classifies story and asset skill packs and keeps module scope', () => {
  const story = new AdmZip();
  story.addFile('inspiration-to-short-drama/SKILL.md', Buffer.from('# story\n把梗概写成剧本'));
  story.addFile('inspiration-to-short-drama/references/screenplay.md', Buffer.from('# screenplay'));
  const asset = new AdmZip();
  asset.addFile('SKILL.md', Buffer.from('---\nmetadata:\n  display_name: 资产\n  version: 3.3.0\n---\n# asset'));
  asset.addFile('docs/view_requirements.md', Buffer.from('# views'));
  const storyPack = rules.readUpload(story.toBuffer(), 'inspiration-to-short-drama-2.0.zip');
  const assetPack = rules.readUpload(asset.toBuffer(), 'visual-asset-skill.zip');
  assert.equal(storyPack.kind, 'story');
  assert.equal(assetPack.kind, 'asset');
  assert.ok(storyPack.active_paths.some(p => p.endsWith('screenplay.md')));
  assert.ok(assetPack.active_paths.includes('docs/view_requirements.md'));
});

test('binds story and asset skills per project without changing extraction modules', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE dramas(id INTEGER PRIMARY KEY, deleted_at TEXT)');
  db.prepare('INSERT INTO dramas VALUES(1, NULL)').run();
  const story = rules.save(db, { kind: 'story', name: '故事', version: '2.0', files: [{ path: 'SKILL.md', content: '# story' }] });
  const asset = rules.save(db, { kind: 'asset', name: '资产', version: '3.3', files: [{ path: 'SKILL.md', content: '# asset' }] });
  const settings = rules.setSettings(db, 1, { story_pack_id: story.id, asset_pack_id: asset.id });
  assert.equal(settings.story_pack_id, story.id);
  assert.equal(settings.asset_pack_id, asset.id);
  assert.match(rules.getModulePrompt(db, 1, 'story_generation'), /# story/);
  assert.match(rules.getModulePrompt(db, 1, 'scene_image_prompt'), /# asset/);
  assert.equal(rules.getModulePrompt(db, 1, 'scene_extraction'), '');
});
