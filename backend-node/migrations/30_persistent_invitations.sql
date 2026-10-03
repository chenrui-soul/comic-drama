-- Keep the verification hash and an encrypted copy for authorized administrators.
ALTER TABLE organization_invitations ADD COLUMN token_encrypted TEXT;
