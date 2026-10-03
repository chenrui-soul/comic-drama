ALTER TABLE organization_invitations ADD COLUMN declined_at TEXT;
CREATE INDEX IF NOT EXISTS idx_invitation_inbox ON organization_invitations(email, accepted_at, revoked_at, declined_at);
