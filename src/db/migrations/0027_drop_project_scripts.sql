-- Custom scripts and the worktree setup command retire with the surfaces
-- that ran them: the project menu no longer offers either, and the
-- worktree-creation path the setup command hung off is gone. One-way:
-- the stored scripts and command are discarded.
ALTER TABLE projects DROP COLUMN custom_scripts;
ALTER TABLE projects DROP COLUMN worktree_setup_command;
