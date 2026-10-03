const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('platform admins can manage users while ordinary users and the last admin are protected', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-users-test-'));
  const envKeys = ['NODE_ENV', 'PUBLIC_ORIGIN', 'DATABASE_PATH', 'STORAGE_PATH', 'CONFIG_PATH', 'PLATFORM_ADMIN_USER_IDS'];
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://studio.example.com',
    DATABASE_PATH: path.join(dir, 'data', 'drama.db'),
    STORAGE_PATH: path.join(dir, 'data', 'storage'),
    CONFIG_PATH: path.join(__dirname, '../../deploy/config.production.yaml'),
    PLATFORM_ADMIN_USER_IDS: '',
  });
  const { createApp } = require('../src/app');
  const { getDb, closeDb } = require('../src/db');
  const auth = require('../src/services/authService');
  const { app, config } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const db = getDb(config.database);
  const bootstrap = auth.register(db, { email: 'bootstrap@test.com', password: 'TestPass123!' });
  const target = auth.register(db, { email: 'newadmin@test.com', password: 'TestPass123!' });
  const member = auth.register(db, { email: 'member@test.com', password: 'TestPass123!' });
  process.env.PLATFORM_ADMIN_USER_IDS = String(bootstrap.user.id);

  const api = async (method, route, session, body) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.session.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json() };
  };

  assert.equal((await api('GET', '/platform/users', member)).status, 403);
  assert.equal((await api('POST', '/organization/workspaces', member, { name: '成员新工作区' })).status, 201);
  const memberWorkspaces = auth.listOrganizations(db, member.user.id);
  const memberOwnedWorkspace = memberWorkspaces.find(item => item.name === '成员新工作区');
  assert.equal(memberOwnedWorkspace.role, 'owner');
  assert.equal((await api('DELETE', `/organization/workspaces/${memberOwnedWorkspace.id}`, target)).status, 403);
  const memberDrama = db.prepare('INSERT INTO dramas(title,organization_id,created_at,updated_at) VALUES (?,?,?,?)')
    .run('工作区待删除项目', memberOwnedWorkspace.id, new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  const memberEpisode = db.prepare('INSERT INTO episodes(drama_id,organization_id) VALUES (?,?)')
    .run(memberDrama, memberOwnedWorkspace.id).lastInsertRowid;
  const memberStoryboard = db.prepare('INSERT INTO storyboards(episode_id,organization_id) VALUES (?,?)')
    .run(memberEpisode, memberOwnedWorkspace.id).lastInsertRowid;
  db.prepare('INSERT INTO frame_prompts(storyboard_id,prompt) VALUES (?,?)').run(memberStoryboard, '待清理提示词');
  const workspaceMediaRelative = `org/${memberOwnedWorkspace.id}/projects/workspace-delete.png`;
  const workspaceMediaPath = path.join(config.storage.local_path, ...workspaceMediaRelative.split('/'));
  fs.mkdirSync(path.dirname(workspaceMediaPath), { recursive: true });
  fs.writeFileSync(workspaceMediaPath, 'workspace media');
  db.prepare('INSERT INTO private_media_owners(path,organization_id,created_at) VALUES (?,?,?)')
    .run(workspaceMediaRelative, memberOwnedWorkspace.id, new Date().toISOString());
  const memberOriginalWorkspace = member.user.organization.id;
  const memberSwitch = await api('POST', '/auth/switch-organization', member, { organization_id: memberOwnedWorkspace.id });
  const memberInNewWorkspace = { ...member, session: memberSwitch.body.data.session };
  const deleteCurrentWorkspace = await api('DELETE', `/organization/workspaces/${memberOwnedWorkspace.id}`, memberInNewWorkspace);
  assert.equal(deleteCurrentWorkspace.status, 200);
  assert.equal(deleteCurrentWorkspace.body.data.user.organization.id, memberOriginalWorkspace);
  assert.ok(auth.resolveSession(db, deleteCurrentWorkspace.body.data.session.token));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dramas WHERE id=?').get(memberDrama).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM frame_prompts WHERE storyboard_id=?').get(memberStoryboard).count, 0);
  assert.equal(fs.existsSync(workspaceMediaPath), false);
  assert.equal((await api('DELETE', `/organization/workspaces/${memberOriginalWorkspace}`, member)).status, 400);

  const searched = await api('GET', '/platform/users?q=newadmin', bootstrap);
  assert.equal(searched.status, 200);
  assert.equal(searched.body.data.items.length, 1);
  assert.equal(searched.body.data.items[0].email, 'newadmin@test.com');
  const renamed = await api('PATCH', `/platform/users/${target.user.id}`, bootstrap, { display_name: '新管理员名称' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.user.display_name, '新管理员名称');
  assert.equal((await api('PATCH', `/platform/users/${member.user.id}`, member, { display_name: '越权修改' })).status, 403);

  assert.equal((await api('DELETE', `/platform/users/${bootstrap.user.id}`, bootstrap)).status, 400);

  const deletable = auth.register(db, { email: 'delete-me@test.com', password: 'TestPass123!' });
  const workspaceId = deletable.user.organization.id;
  db.prepare("INSERT INTO organization_members(organization_id,user_id,role,created_at) VALUES (?,?,'owner',?)")
    .run(workspaceId, bootstrap.user.id, new Date().toISOString());
  const dramaId = db.prepare('INSERT INTO dramas(title,organization_id,created_at,updated_at) VALUES (?,?,?,?)')
    .run('待删除项目', workspaceId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  const episodeId = db.prepare('INSERT INTO episodes(drama_id,organization_id) VALUES (?,?)').run(dramaId, workspaceId).lastInsertRowid;
  const storyboardId = db.prepare('INSERT INTO storyboards(episode_id,organization_id) VALUES (?,?)').run(episodeId, workspaceId).lastInsertRowid;
  db.prepare('INSERT INTO frame_prompts(storyboard_id,prompt) VALUES (?,?)').run(storyboardId, '测试提示词');
  const configId = db.prepare("INSERT INTO ai_service_configs(service_type,organization_id) VALUES ('video',?)").run(workspaceId).lastInsertRowid;
  db.prepare('INSERT INTO doubao_local_access(config_id,organization_id,owner_user_id,updated_at) VALUES (?,?,?,?)')
    .run(configId, workspaceId, deletable.user.id, new Date().toISOString());
  const relativeMediaPath = `org/${workspaceId}/projects/delete-test.png`;
  const mediaPath = path.join(config.storage.local_path, ...relativeMediaPath.split('/'));
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, 'workspace media');
  db.prepare('INSERT INTO private_media_owners(path,organization_id,created_at) VALUES (?,?,?)')
    .run(relativeMediaPath, workspaceId, new Date().toISOString());
  const deleted = await api('DELETE', `/platform/users/${deletable.user.id}`, bootstrap);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.deleted_workspace_count, 1);
  assert.equal(auth.resolveSession(db, deletable.session.token), null);
  assert.equal(db.prepare('SELECT status, display_name FROM users WHERE id=?').get(deletable.user.id).status, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_members WHERE user_id=?').get(deletable.user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organizations WHERE id=?').get(workspaceId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dramas WHERE organization_id=?').get(workspaceId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM frame_prompts WHERE storyboard_id=?').get(storyboardId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM doubao_local_access WHERE config_id=?').get(configId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_members WHERE user_id=? AND organization_id=?').get(bootstrap.user.id, workspaceId).count, 0);
  assert.equal(fs.existsSync(mediaPath), false);
  assert.equal((await api('GET', `/platform/users?q=delete-me`, bootstrap)).body.data.total, 0);

  const granted = await api('PATCH', `/platform/users/${target.user.id}/admin`, bootstrap, { enabled: true });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.data.is_platform_admin, true);
  assert.equal(auth.resolveSession(db, target.session.token).is_platform_admin, true);
  assert.equal((await api('POST', '/announcements', target, { title: '管理员公告', content: '可发布' })).status, 201);

  assert.equal((await api('PATCH', `/platform/users/${target.user.id}/admin`, member, { enabled: false })).status, 403);
  assert.equal((await api('PATCH', `/platform/users/${bootstrap.user.id}/admin`, bootstrap, { enabled: false })).status, 400);
  const revoked = await api('PATCH', `/platform/users/${target.user.id}/admin`, bootstrap, { enabled: false });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.is_platform_admin, false);
  assert.equal(auth.resolveSession(db, target.session.token).is_platform_admin, false);
  assert.equal((await api('POST', '/announcements', target, { title: '普通账号', content: '不可发布' })).status, 403);

  db.prepare('INSERT INTO platform_admins (user_id, granted_by_user_id, created_at) VALUES (?, ?, ?)')
    .run(bootstrap.user.id, bootstrap.user.id, new Date().toISOString());
  process.env.PLATFORM_ADMIN_USER_IDS = '';
  assert.equal(auth.resolveSession(db, bootstrap.session.token).is_platform_admin, true);
  const lastAdmin = await api('PATCH', `/platform/users/${bootstrap.user.id}/admin`, bootstrap, { enabled: false });
  assert.equal(lastAdmin.status, 400);
  assert.match(lastAdmin.body.error.message, /至少保留一名平台管理员/);

  const actions = db.prepare(`SELECT action FROM platform_audit_logs WHERE resource_type='platform_user' ORDER BY id`).all();
  assert.deepEqual(actions.map(row => row.action), ['user.display_name_updated', 'user.deleted', 'user.admin_granted', 'user.admin_revoked']);
});
