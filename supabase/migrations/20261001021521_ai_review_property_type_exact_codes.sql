begin;

set local lock_timeout = '5s';

-- Property type has a deliberately smaller SQL vocabulary than the broad
-- source normalizer.  Keep this table closed: only the five reviewed French
-- labels and the canonical catalogue codes may participate in reconciliation.
-- In particular, do not add substring-derived labels here.
create or replace function app_private.ai_review_normalize_property_type(p_text text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  with exact_aliases(label, canonical_code) as (
    values
      ('appartement'::text, 'apartment'::text),
      ('maison'::text, 'house'::text),
      ('immeuble'::text, 'building'::text),
      ('terrain'::text, 'land'::text),
      ('ensemble immobilier'::text, 'mixed'::text),
      ('apartment'::text, 'apartment'::text),
      ('house'::text, 'house'::text),
      ('building'::text, 'building'::text),
      ('commercial'::text, 'commercial'::text),
      ('mixed'::text, 'mixed'::text),
      ('land'::text, 'land'::text),
      ('parking'::text, 'parking'::text),
      ('other'::text, 'other'::text)
  )
  select exact_aliases.canonical_code
  from exact_aliases
  where exact_aliases.label = app_private.ai_review_normalize_text(p_text);
$function$;

revoke all on function app_private.ai_review_normalize_property_type(text)
from public, anon, authenticated, service_role;

-- Patch the latest comparison definition in place.  The anchor checks make
-- this migration fail closed if it is ever applied against a comparison
-- function other than the post-405 single-row-missing definition.
do $$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.ai_review_compare_field(text,jsonb,uuid)'::regprocedure
  );
  missing_canonical_anchor constant text := $anchor$
        comparison_reason := 'canonical value is missing';
        return next;
        return;
$anchor$;
  missing_occupancy_anchor constant text := $anchor$
        comparison_reason := 'canonical occupancy is missing or unknown';
        return next;
        return;
$anchor$;
  property_type_anchor constant text := $anchor$
    when 'property.property_type' then
      value_kind := 'text';
      canonical_text := nullif(pg_catalog.btrim(sale_row.property_type), '');
$anchor$;
  canonical_normalization_anchor constant text := $anchor$
      normalized_canonical_value := case
        when value_kind = 'energy' then pg_catalog.upper(canonical_text)
        else app_private.ai_review_normalize_text(canonical_text)
      end;
$anchor$;
  text_value_kinds_anchor constant text := $anchor$
  if value_kind in ('text', 'occupancy', 'energy') then
$anchor$;
  ai_normalization_anchor constant text := $anchor$
    if value_kind = 'occupancy' then
      ai_occupancy := app_private.ai_review_normalize_occupancy(ai_text);
      if ai_occupancy is null or ai_occupancy = 'unknown' then
        ai_unsupported := true;
      else
        normalized_ai_value := ai_occupancy;
      end if;
    elsif value_kind = 'energy' then
      ai_text := pg_catalog.btrim(ai_text);
      if ai_text !~* '^[A-G]$' then
        ai_unsupported := true;
      else
        normalized_ai_value := pg_catalog.upper(ai_text);
      end if;
    else
      normalized_ai_value := app_private.ai_review_normalize_text(ai_text);
      if normalized_ai_value is null then
        ai_unsupported := true;
      end if;
    end if;
$anchor$;
begin
  if (
    (length(definition) - length(replace(definition, missing_canonical_anchor, '')))
      / length(missing_canonical_anchor) <> 1
    or (length(definition) - length(replace(definition, missing_occupancy_anchor, '')))
      / length(missing_occupancy_anchor) <> 1
    or (length(definition) - length(replace(definition, property_type_anchor, '')))
      / length(property_type_anchor) <> 1
    or (length(definition) - length(replace(definition, canonical_normalization_anchor, '')))
      / length(canonical_normalization_anchor) <> 1
    or (length(definition) - length(replace(definition, text_value_kinds_anchor, '')))
      / length(text_value_kinds_anchor) <> 1
    or (length(definition) - length(replace(definition, ai_normalization_anchor, '')))
      / length(ai_normalization_anchor) <> 1
  ) then
    raise exception
      'Unexpected AI review comparison definition; refusing to install exact property type reconciliation.';
  end if;

  definition := replace(
    definition,
    property_type_anchor,
    replace(property_type_anchor, 'value_kind := ''text'';', 'value_kind := ''property_type'';')
  );
  definition := replace(
    definition,
    canonical_normalization_anchor,
    $replacement$
      normalized_canonical_value := case
        when value_kind = 'property_type'
          then app_private.ai_review_normalize_property_type(canonical_text)
        when value_kind = 'energy' then pg_catalog.upper(canonical_text)
        else app_private.ai_review_normalize_text(canonical_text)
      end;
      if value_kind = 'property_type'
        and normalized_canonical_value is null then
        comparison_status := 'unsupported';
        comparison_reason := 'canonical property type is not a recognized exact value';
        return next;
        return;
      end if;
$replacement$
  );
  definition := replace(
    definition,
    text_value_kinds_anchor,
    $replacement$
  if value_kind in ('text', 'property_type', 'occupancy', 'energy') then
$replacement$
  );
  definition := replace(
    definition,
    ai_normalization_anchor,
    $replacement$
    if value_kind = 'occupancy' then
      ai_occupancy := app_private.ai_review_normalize_occupancy(ai_text);
      if ai_occupancy is null or ai_occupancy = 'unknown' then
        ai_unsupported := true;
      else
        normalized_ai_value := ai_occupancy;
      end if;
    elsif value_kind = 'property_type' then
      normalized_ai_value := app_private.ai_review_normalize_property_type(ai_text);
      if normalized_ai_value is null then
        ai_unsupported := true;
      end if;
    elsif value_kind = 'energy' then
      ai_text := pg_catalog.btrim(ai_text);
      if ai_text !~* '^[A-G]$' then
        ai_unsupported := true;
      else
        normalized_ai_value := pg_catalog.upper(ai_text);
      end if;
    else
      normalized_ai_value := app_private.ai_review_normalize_text(ai_text);
      if normalized_ai_value is null then
        ai_unsupported := true;
      end if;
    end if;
$replacement$
  );
  execute definition;
end;
$$;

-- CREATE OR REPLACE preserves the comparison function identity.  Reassert the
-- existing service-role-only boundary after replacing its body.
revoke all on function app_private.ai_review_compare_field(text, jsonb, uuid)
from public, anon, authenticated;
grant execute on function app_private.ai_review_compare_field(text, jsonb, uuid)
to service_role;

comment on function app_private.ai_review_normalize_property_type(text) is
  'Private exact property type reconciliation aliases; no substring or unreviewed source vocabulary mapping.';

notify pgrst, 'reload schema';

commit;
