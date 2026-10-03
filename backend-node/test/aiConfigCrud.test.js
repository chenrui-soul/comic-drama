const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('AI config HTTP lifecycle: all service types, saved fields, defaults and workspace isolation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidrama-ai-config-'));
  Object.assign(process.env, {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://studio.example.com',
    DATABASE_PATH: path.join(dir, 'drama.db'), STORAGE_PATH: path.join(dir, 'storage'),
    ALLOW_REGISTRATION: 'true', CONFIG_PATH: path.join(__dirname, '../../deploy/config.production.yaml'),
  });
  const { createApp } = require('../src/app');
  const { getDb, closeDb } = require('../src/db');
  const { app, config } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections(); server.close(); closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function api(route, method, body, token, expected = 200) {
    const res = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, expected, `${method} ${route}`);
    return (await res.json()).data;
  }
  const a = await api('/auth/register', 'POST', { email: 'a@config.invalid', password: 'TestPass123!' }, null, 201);
  const b = await api('/auth/register', 'POST', { email: 'b@config.invalid', password: 'TestPass123!' }, null, 201);
  assert.equal((await api('/ai-configs/policy', 'GET', undefined, a.session.token)).allow_user_ai_config, true);
  const payload = {
    service_type: 'text', name: 'OpenAI 文本', provider: 'openai', api_protocol: '',
    base_url: 'https://provider.invalid', api_key: 'synthetic-test-key',
    model: ['gpt-6-astra'], default_model: 'gpt-6-astra', endpoint: '', query_endpoint: '',
    priority: 0, is_default: true,
  };
  await api('/ai-configs', 'POST', payload, null, 401);
  const ids = [];
  for (const serviceType of ['text', 'image', 'storyboard_image', 'video', 'tts', 'jimeng2_character_auth', 'model_ark_asset']) {
    const settings = serviceType === 'tts' ? JSON.stringify({ voice_id: 'test-voice', group_id: 'test-group' }) : null;
    const created = await api('/ai-configs', 'POST', { ...payload, service_type: serviceType, settings }, a.session.token, 201);
    ids.push(created.id);
    const saved = await api(`/ai-configs/${created.id}`, 'GET', undefined, a.session.token);
    assert.equal(saved.service_type, serviceType);
    assert.equal(saved.name, payload.name);
    assert.equal(saved.base_url, payload.base_url);
    assert.deepEqual(saved.model, payload.model);
    assert.equal(saved.default_model, payload.default_model);
    assert.equal(saved.is_default, true);
    assert.equal(saved.is_active, true);
    assert.equal(saved.settings, settings);
    assert.equal(getDb(config.database).prepare('SELECT organization_id FROM ai_service_configs WHERE id=?').get(created.id).organization_id, a.user.organization.id);
  }
  const foreign = await api('/ai-configs', 'POST', payload, b.session.token, 201);
  const second = await api('/ai-configs', 'POST', { ...payload, name: '第二个文本配置' }, a.session.token, 201);
  const list = await api('/ai-configs?service_type=text', 'GET', undefined, a.session.token);
  assert.equal(list.length, 2);
  assert.deepEqual(list.filter(c => c.is_default).map(c => c.id), [second.id]);
  assert.equal((await api(`/ai-configs/${foreign.id}`, 'GET', undefined, b.session.token)).is_default, true);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    await api(`/ai-configs/${ids[0]}`, method, method === 'PUT' ? { name: 'forbidden' } : undefined, b.session.token, 404);
  }
  await api(`/ai-configs/${ids[0]}`, 'PUT', {
    name: '已编辑', api_key: 'updated-synthetic-key', model: ['model-a', 'model-b'],
    default_model: 'model-b', endpoint: '/v1/chat/completions', priority: 5, is_default: true,
  }, a.session.token);
  const edited = await api(`/ai-configs/${ids[0]}`, 'GET', undefined, a.session.token);
  assert.equal(edited.name, '已编辑');
  assert.equal(edited.api_key, 'updated-synthetic-key');
  assert.deepEqual(edited.model, ['model-a', 'model-b']);
  assert.equal(edited.default_model, 'model-b');
  assert.equal(edited.endpoint, '/v1/chat/completions');
  assert.equal(edited.priority, 5);
  assert.equal(edited.is_default, true);
  assert.equal((await api(`/ai-configs/${second.id}`, 'GET', undefined, a.session.token)).is_default, false);
  await api(`/ai-configs/${second.id}`, 'DELETE', undefined, a.session.token);
  await api(`/ai-configs/${second.id}`, 'GET', undefined, a.session.token, 404);
  assert.equal((await api('/ai-configs', 'GET', undefined, a.session.token)).length, 7);
});

test('vendor configuration import inserts every field and preserves saved key on resync', t => {
  const Database = require('better-sqlite3');
  const { runMigrationsAndEnsure } = require('../src/db/migrate');
  const service = require('../src/services/aiConfigService');
  const db = new Database(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidrama-vendor-config-'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  runMigrationsAndEnsure(db);
  fs.mkdirSync(path.join(dir, 'configs'));
  t.mock.method(process, 'cwd', () => dir);
  const fixture = path.join(dir, 'configs', 'vendor.json');
  fs.writeFileSync(fixture, JSON.stringify([{
    service_type: 'text', provider: 'openai', name: 'Imported text', base_url: 'https://provider.invalid',
    api_key: 'synthetic-import-key', model: ['model-a'], default_model: 'model-a', is_default: true,
  }]));
  const cfg = { vendor_lock: { enabled: true, config_file: 'vendor.json' } };
  const log = { info() {}, warn() {} };
  service.applyVendorLock(db, log, cfg);
  const imported = service.listConfigs(db);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].default_model, 'model-a');
  assert.equal(imported[0].is_active, true);
  service.updateConfig(db, log, imported[0].id, { api_key: 'saved-synthetic-key' });
  service.applyVendorLock(db, log, cfg);
  const synced = service.listConfigs(db);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].api_key, 'saved-synthetic-key');
});

test('platform AI policy switches workspace configuration scope without deleting workspace configs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minidrama-platform-ai-'));
  const previousAdminIds = process.env.PLATFORM_ADMIN_USER_IDS;
  Object.assign(process.env, {
    NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://studio.example.com',
    DATABASE_PATH: path.join(dir, 'drama.db'), STORAGE_PATH: path.join(dir, 'storage'),
    ALLOW_REGISTRATION: 'true', CONFIG_PATH: path.join(__dirname, '../../deploy/config.production.yaml'),
    PLATFORM_ADMIN_USER_IDS: '',
  });
  const { createApp } = require('../src/app');
  const { getDb, closeDb } = require('../src/db');
  const { app, config } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections(); server.close(); closeDb();
    if (previousAdminIds === undefined) delete process.env.PLATFORM_ADMIN_USER_IDS;
    else process.env.PLATFORM_ADMIN_USER_IDS = previousAdminIds;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function api(route, method, body, token, expected = 200) {
    const res = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, expected, `${method} ${route}`);
    return (await res.json()).data;
  }
  const owner = await api('/auth/register', 'POST', { email: 'platform-owner@config.invalid', password: 'TestPass123!' }, null, 201);
  const other = await api('/auth/register', 'POST', { email: 'platform-other@config.invalid', password: 'TestPass123!' }, null, 201);
  const db = getDb(config.database);
  const service = require('../src/services/aiConfigService');
  const { runWithTenant } = require('../src/utils/tenantContext');
  const payload = {
    service_type: 'text', name: 'Workspace text', provider: 'openai', base_url: 'https://workspace.invalid',
    api_key: 'workspace-test-key', model: ['workspace-model'], default_model: 'workspace-model', is_default: true,
  };
  const workspaceConfig = await api('/ai-configs', 'POST', payload, owner.session.token, 201);
  process.env.PLATFORM_ADMIN_USER_IDS = String(owner.user.id);
  assert.equal((await api('/platform/ai-config-policy', 'GET', undefined, owner.session.token)).allow_user_ai_config, true);
  await api('/platform/ai-config-policy', 'PUT', { allow_user_ai_config: false }, owner.session.token, 400);
  await api('/platform/ai-configs', 'GET', undefined, other.session.token, 403);
  const platformConfig = await api('/platform/ai-configs', 'POST', {
    ...payload, name: 'Platform text', base_url: 'https://platform.invalid', api_key: 'platform-test-key',
  }, owner.session.token, 201);
  await api('/platform/ai-config-policy', 'PUT', { allow_user_ai_config: false }, owner.session.token);
  assert.equal((await api('/ai-configs', 'GET', undefined, owner.session.token)).length, 1);
  assert.equal((await api('/ai-configs', 'GET', undefined, owner.session.token))[0].id, platformConfig.id);
  assert.equal((await api('/ai-configs', 'GET', undefined, other.session.token))[0].api_key, null);
  await api('/ai-configs', 'POST', payload, owner.session.token, 403);
  await api(`/ai-configs/${workspaceConfig.id}`, 'PUT', { name: 'blocked' }, owner.session.token, 403);
  await api(`/ai-configs/${workspaceConfig.id}`, 'DELETE', undefined, owner.session.token, 403);
  assert.equal(runWithTenant(owner.user.organization.id, () => service.listConfigs(db, 'text')[0].id), platformConfig.id);
  assert.equal(runWithTenant(other.user.organization.id, () => service.listConfigs(db, 'text')[0].id), platformConfig.id);
  await api('/platform/ai-config-policy', 'PUT', { allow_user_ai_config: true }, owner.session.token);
  assert.equal((await api('/ai-configs', 'GET', undefined, owner.session.token))[0].id, workspaceConfig.id);
  assert.equal((await api('/platform/ai-configs', 'GET', undefined, owner.session.token))[0].api_key, 'platform-test-key');
});
