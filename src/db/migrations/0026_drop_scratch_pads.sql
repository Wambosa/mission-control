-- Scratch pads are gone from the interface and the API, so their table
-- retires with them. One-way: the stored pads are discarded. The only
-- full-text index in this database is over project_memory and is untouched.
DROP INDEX IF EXISTS scratch_pads_project_updated_idx;
DROP INDEX IF EXISTS scratch_pads_project_idx;
DROP TABLE IF EXISTS scratch_pads;
