-- v0.11.0 replaced this table with `embedding_generation_failure` (one row per
-- generation and file); it stayed only because v0.10 replicas still wrote it
-- during that upgrade. No release since v0.11.0 reads or writes it, so it goes
-- now, with its index and checks.
-- oci:lint-allow drop-table: unused since v0.11.0, which replaced it with embedding_generation_failure; v0.12.0 (the previous release) never reads it
DROP TABLE IF EXISTS "project_file_embedding_failure";
