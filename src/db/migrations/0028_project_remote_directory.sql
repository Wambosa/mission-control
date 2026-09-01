-- Where a project lives on its SSH host. Previously inferred by lowercasing
-- and hyphenating the local folder's basename, which put sessions in a
-- directory the host may never have had. Now configuration, set beside the
-- host in project settings. Existing projects start null: the derivation
-- cannot be reproduced in SQL (its root was a renderer-cached read of
-- whichever scope was active), so the operator sets it once per project.
ALTER TABLE projects ADD COLUMN remote_directory TEXT;
