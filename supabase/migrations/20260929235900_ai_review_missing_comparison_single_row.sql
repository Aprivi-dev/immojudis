begin;

set local lock_timeout = '5s';

-- The original comparison function emitted the missing row for a NULL
-- canonical text/energy or occupancy value, then fell through to the AI
-- comparison branch.  Patch only those two bounded anchors in place so the
-- existing function OID, signature, security attributes and ACL remain
-- unchanged.
do $$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.ai_review_compare_field(text,jsonb,uuid)'::regprocedure
  );
  occupancy_anchor constant text := $anchor$
      if canonical_occupancy is null then
        comparison_status := 'missing';
        comparison_reason := 'canonical occupancy is missing or unknown';
        return next;
$anchor$;
  canonical_anchor constant text := $anchor$
      if canonical_text is null then
        comparison_status := 'missing';
        comparison_reason := 'canonical value is missing';
        return next;
$anchor$;
begin
  if (
    (length(definition) - length(replace(definition, occupancy_anchor, '')))
      / length(occupancy_anchor) <> 1
    or (length(definition) - length(replace(definition, canonical_anchor, '')))
      / length(canonical_anchor) <> 1
  ) then
    raise exception
      'Unexpected AI review comparison definition; refusing to patch missing-row exits.';
  end if;

  definition := replace(
    definition,
    occupancy_anchor,
    occupancy_anchor || '        return;' || chr(10)
  );
  definition := replace(
    definition,
    canonical_anchor,
    canonical_anchor || '        return;' || chr(10)
  );
  execute definition;
end;
$$;

-- CREATE OR REPLACE preserves the existing function identity.  Reassert the
-- established private execution boundary explicitly for release drift.
revoke all on function app_private.ai_review_compare_field(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function app_private.ai_review_compare_field(text, jsonb, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
