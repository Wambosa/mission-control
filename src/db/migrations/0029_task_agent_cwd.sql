-- The directory the session's agent last reported working in, from the agent
-- lifecycle hook. Null until an event arrives, and for sessions that predate
-- this. Read-only: the session header states it, nothing sets it by hand.
ALTER TABLE tasks ADD COLUMN agent_cwd TEXT;
