-- The launch runner is gone: nothing in the interface starts, stops, or
-- records a project's launch commands, so the two columns behind it retire
-- with it. One-way — the stored commands and last-seen URL are discarded.
ALTER TABLE projects DROP COLUMN launch_commands;
ALTER TABLE projects DROP COLUMN launch_url;
