-- Historical production migration.
--
-- Production already has this migration version in
-- supabase_migrations.schema_migrations. The final view shape is defined by the
-- later add_about_description_to_app_view migration, which includes
-- raw_payload->'source_blocks'. This placeholder keeps local migration history
-- aligned with production without re-opening old public grants.

notify pgrst, 'reload schema';
