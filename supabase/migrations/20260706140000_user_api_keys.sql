begin;

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  key_prefix text not null unique,
  key_hash text not null unique,
  scopes text[] not null default array['sales.feed:read']::text[],
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(name) between 2 and 80),
  check (char_length(key_prefix) >= 12),
  check (char_length(key_hash) = 64)
);

comment on table public.user_api_keys is
  'User-owned hashed API keys for paid ImmoJudis light API access. Raw keys are never stored.';

comment on column public.user_api_keys.key_hash is
  'SHA-256 hash of the generated API key. Never expose the raw key or hash to browser clients.';

create index if not exists user_api_keys_user_created_idx
  on public.user_api_keys (user_id, created_at desc);

create index if not exists user_api_keys_active_lookup_idx
  on public.user_api_keys (key_prefix, revoked_at, expires_at);

alter table public.user_api_keys enable row level security;

revoke all on table public.user_api_keys from anon, authenticated;
grant select, insert, update, delete on table public.user_api_keys to service_role;

drop trigger if exists immojudis_user_api_keys_updated_at
on public.user_api_keys;
create trigger immojudis_user_api_keys_updated_at
before update on public.user_api_keys
for each row
execute function app_private.set_user_profiles_updated_at();

notify pgrst, 'reload schema';

commit;
