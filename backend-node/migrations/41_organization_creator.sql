ALTER TABLE organizations ADD COLUMN created_by_user_id INTEGER REFERENCES users(id);
UPDATE organizations
SET created_by_user_id = (
  SELECT user_id FROM organization_members
  WHERE organization_id = organizations.id AND role = 'owner'
  ORDER BY created_at ASC, id ASC LIMIT 1
)
WHERE created_by_user_id IS NULL;
