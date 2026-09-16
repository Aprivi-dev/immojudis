begin;

-- The previous audit format stored two complete auction_sales rows as JSONB.
-- Keep only the changed columns and compact fingerprints for large values.
alter table public.auction_sale_history
  add column if not exists changed_fields jsonb not null default '{}'::jsonb;

-- The old snapshots are explicitly no longer retained. This is intentionally
-- scoped to the audit table; auction_sales and all other application data stay.
truncate table public.auction_sale_history;

alter table public.auction_sale_history
  drop column if exists old_row,
  drop column if exists new_row;

create or replace function public.log_auction_sale_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed jsonb;
begin
  select coalesce(
    jsonb_object_agg(
      current_value.key,
      case
        when jsonb_typeof(current_value.value) in ('object', 'array')
          or pg_column_size(current_value.value) > 2048
        then jsonb_build_object(
          'kind', 'changed_value_fingerprint',
          'size_bytes', pg_column_size(current_value.value),
          'md5', md5(current_value.value::text)
        )
        else current_value.value
      end
    ),
    '{}'::jsonb
  )
  into changed
  from jsonb_each(to_jsonb(new)) as current_value(key, value)
  left join jsonb_each(to_jsonb(old)) as previous_value(key, value)
    on previous_value.key = current_value.key
  where current_value.key not in ('updated_at', 'last_seen_at')
    and current_value.value is distinct from previous_value.value;

  if changed <> '{}'::jsonb then
    insert into public.auction_sale_history (source_url, changed_at, changed_fields)
    values (new.source_url, statement_timestamp(), changed);
  end if;
  return new;
end;
$$;

revoke all on function public.log_auction_sale_change() from public, anon, authenticated;
grant execute on function public.log_auction_sale_change() to service_role;

comment on table public.auction_sale_history is
  'Compact audit of changed auction_sale fields; previous full row versions are not retained.';

commit;
