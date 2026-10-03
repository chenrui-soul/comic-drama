const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const service = require('../src/services/organizationService');
const auth = require('../src/services/authService');

function createConfirmedInvitation(db, owner, input) {
  const recipient = db.prepare('SELECT id FROM users WHERE email=?').get(input.email);
  return service.createInvitation(db, owner, { ...input, recipient_user_id: recipient?.id });
}

function setup(t, filename = ':memory:') {
  const db = new Database(filename);
  t.after(() => { if (db.open) db.close(); });
  for (const file of ['23_auth_identity.sql', '27_organization_membership_management.sql', '30_persistent_invitations.sql', '31_invitation_inbox.sql', '32_invitation_recipient.sql']) {
    db.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  }
  const owner = auth.register(db, { email: 'owner@example.com', password: 'TestPass123!' }).user;
  const member = auth.register(db, { email: 'member@example.com', password: 'TestPass123!' }).user;
  auth.register(db, { email: 'other@example.com', password: 'TestPass123!' });
  return { db, owner, member };
}

test('current code persists across database reopen and remains encrypted at rest', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invitation-test-'));
  const filename = path.join(dir, 'test.db');
  const { db, owner } = setup(t, filename);
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const invite = createConfirmedInvitation(db, owner, { email: 'member@example.com' });
  const stored = db.prepare('SELECT token_encrypted FROM organization_invitations WHERE id=?').get(invite.id);
  assert.ok(!stored.token_encrypted.includes(invite.token));
  db.close();
  const reopened = new Database(filename);
  try {
    const list = service.listInvitations(reopened, owner.organization.id);
    assert.equal(list[0].token, invite.token);
    assert.equal(list[0].expires_at, null);
    assert.equal(list[0].token_encrypted, undefined);
  } finally { reopened.close(); }
});

test('rotation shows latest per email, invalidates old code and isolates organizations', t => {
  const { db, owner, member } = setup(t);
  const old = createConfirmedInvitation(db, owner, { email: member.email });
  const current = createConfirmedInvitation(db, owner, { email: member.email });
  createConfirmedInvitation(db, owner, { email: 'other@example.com' });
  const list = service.listInvitations(db, owner.organization.id);
  assert.equal(list.length, 2);
  assert.equal(list.find(i => i.email === member.email).token, current.token);
  assert.deepEqual(service.listInvitations(db, member.organization.id), []);
  assert.throws(() => service.acceptInvitation(db, member, old.token), { code: 'INVITE_INVALID' });
  assert.throws(() => service.acceptInvitation(db, owner, current.token), { code: 'INVITE_EMAIL_MISMATCH' });
  assert.equal(service.acceptInvitation(db, member, current.token).organization.id, owner.organization.id);
  assert.equal(service.listInvitations(db, owner.organization.id).find(i => i.email === member.email).token, null);
  assert.throws(() => service.acceptInvitation(db, member, current.token), { code: 'INVITE_INVALID' });
});

test('legacy code has no time expiry, missing display copy does not invalidate it, revocation still works', t => {
  const { db, owner, member } = setup(t);
  const invite = createConfirmedInvitation(db, owner, { email: member.email });
  db.prepare('UPDATE organization_invitations SET expires_at=?,token_encrypted=NULL WHERE id=?').run('2000-01-01', invite.id);
  const row = service.listInvitations(db, owner.organization.id)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.token, null);
  assert.equal(service.acceptInvitation(db, member, invite.token).organization.id, owner.organization.id);
  const revoked = createConfirmedInvitation(db, owner, { email: 'other@example.com' });
  assert.equal(service.revokeInvitation(db, owner, revoked.id), true);
  assert.throws(() => service.acceptInvitation(db, { ...member, id: db.prepare('SELECT id FROM users WHERE email=?').get('other@example.com').id, email: 'other@example.com' }, revoked.token), { code: 'INVITE_INVALID' });
});

test('failed rotation rolls back revocation of previous invitation', t => {
  const { db, owner } = setup(t);
  const original = createConfirmedInvitation(db, owner, { email: 'member@example.com' });
  db.exec("CREATE TRIGGER fail_invite BEFORE INSERT ON organization_invitations BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => createConfirmedInvitation(db, owner, { email: 'member@example.com' }));
  assert.equal(service.listInvitations(db, owner.organization.id)[0].token, original.token);
  assert.equal(service.listInvitations(db, owner.organization.id)[0].status, 'pending');
});

test('inbox requires a confirmed registered recipient and does not expose codes', t => {
  const { db, owner, member } = setup(t);
  assert.throws(() => createConfirmedInvitation(db, owner, { email: 'future@example.com' }), { code: 'RECIPIENT_UNCONFIRMED' });
  const future = auth.register(db, { email: 'future@example.com', password: 'TestPass123!' }).user;
  const invite = createConfirmedInvitation(db, owner, { email: future.email });
  const inbox = service.listReceivedInvitations(db, future);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, invite.id);
  assert.equal(inbox[0].organization_name, owner.organization.name);
  assert.equal(inbox[0].token, undefined);
  assert.equal(inbox[0].token_hash, undefined);
  assert.deepEqual(service.listReceivedInvitations(db, member), []);
  for (const accept of [true, false]) {
    assert.throws(() => service.respondToInvitation(db, member, invite.id, accept), { code: 'INVITE_EMAIL_MISMATCH' });
  }
  service.respondToInvitation(db, future, invite.id, true);
  assert.equal(auth.listOrganizations(db, future.id).length, 2);
  assert.deepEqual(service.listReceivedInvitations(db, future), []);
  assert.throws(() => service.respondToInvitation(db, future, invite.id, true), { code: 'INVITE_INVALID' });
});

test('decline, resend and revoke are terminal for the previous message', t => {
  const { db, owner, member } = setup(t);
  const first = createConfirmedInvitation(db, owner, { email: member.email });
  service.respondToInvitation(db, member, first.id, false);
  assert.equal(service.listInvitations(db, owner.organization.id)[0].status, 'declined');
  assert.equal(auth.listOrganizations(db, member.id).length, 1);
  assert.throws(() => service.acceptInvitation(db, member, first.token), { code: 'INVITE_INVALID' });
  const second = createConfirmedInvitation(db, owner, { email: member.email });
  const third = createConfirmedInvitation(db, owner, { email: member.email });
  assert.deepEqual(service.listReceivedInvitations(db, member).map(i => i.id), [third.id]);
  assert.throws(() => service.respondToInvitation(db, member, second.id, true), { code: 'INVITE_INVALID' });
  service.revokeInvitation(db, owner, third.id);
  assert.throws(() => service.respondToInvitation(db, member, third.id, true), { code: 'INVITE_INVALID' });
  assert.deepEqual(service.listReceivedInvitations(db, member), []);
});

test('owner/admin removal enforces roles and revokes only target workspace sessions permanently', t => {
  const { db, owner, member } = setup(t);
  const adminUser = auth.register(db, { email: 'admin@example.com', password: 'TestPass123!' }).user;
  for (const [user, role] of [[member, 'member'], [adminUser, 'admin']]) {
    const invite = createConfirmedInvitation(db, owner, { email: user.email, role });
    service.respondToInvitation(db, user, invite.id, true);
  }
  const admin = auth.switchOrganization(db, adminUser, owner.organization.id).user;
  const memberSession = auth.switchOrganization(db, member, owner.organization.id);
  const personal = auth.login(db, { email: member.email, password: 'TestPass123!' });
  assert.throws(() => service.removeMember(db, memberSession.user, admin.id), /权限/);
  assert.throws(() => service.removeMember(db, admin, owner.id), /所有者/);
  assert.throws(() => service.removeMember(db, admin, admin.id), /权限/);
  assert.equal(service.removeMember(db, admin, member.id), true);
  assert.equal(auth.resolveSession(db, memberSession.session.token), null);
  assert.ok(auth.resolveSession(db, personal.session.token));
  const newInvite = createConfirmedInvitation(db, owner, { email: member.email });
  service.respondToInvitation(db, member, newInvite.id, true);
  assert.equal(auth.resolveSession(db, memberSession.session.token), null);
  assert.equal(service.removeMember(db, owner, admin.id), true);
});


test('unbound legacy invitations and mismatched IDs cannot grant access', t => {
  const { db, owner, member } = setup(t);
  assert.throws(() => service.createInvitation(db, owner, { email: member.email }), { code: 'RECIPIENT_UNCONFIRMED' });
  assert.throws(() => service.createInvitation(db, owner, { email: member.email, recipient_user_id: owner.id }), { code: 'RECIPIENT_UNCONFIRMED' });
  const invite = createConfirmedInvitation(db, owner, { email: member.email });
  db.prepare('UPDATE organization_invitations SET recipient_user_id=NULL WHERE id=?').run(invite.id);
  assert.deepEqual(service.listReceivedInvitations(db, member), []);
  assert.throws(() => service.acceptInvitation(db, member, invite.token), { code: 'INVITE_EMAIL_MISMATCH' });
  assert.equal(service.listInvitations(db, owner.organization.id)[0].status, 'needs_confirmation');
});
