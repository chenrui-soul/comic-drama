-- Legacy invitations remain unbound until an administrator explicitly sends a new one.
ALTER TABLE organization_invitations ADD COLUMN recipient_user_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_invitation_recipient ON organization_invitations(recipient_user_id);
