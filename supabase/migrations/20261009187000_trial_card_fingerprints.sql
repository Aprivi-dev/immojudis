begin;

set local lock_timeout = '5s';

-- A free trial is granted once per payment card, not once per account.  Stripe
-- gives every physical card a stable fingerprint; only a hash of it is kept.
create table if not exists app_private.trial_card_fingerprints (
  fingerprint_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table app_private.trial_card_fingerprints is
  'SHA-256 of the Stripe card fingerprint that started a free trial, with the account that used it.';

create index if not exists trial_card_fingerprints_user_idx
  on app_private.trial_card_fingerprints (user_id);

revoke all on table app_private.trial_card_fingerprints from public, anon, authenticated;

-- Returns true when the card is new or already belongs to this user, false
-- when another account already used it for a trial.
create or replace function public.claim_trial_card(
  p_user_id uuid,
  p_fingerprint_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  owner uuid;
begin
  if p_user_id is null or p_fingerprint_hash is null or length(p_fingerprint_hash) <> 64 then
    raise exception using errcode = '22023', message = 'Invalid trial card claim.';
  end if;

  insert into app_private.trial_card_fingerprints (fingerprint_hash, user_id)
  values (p_fingerprint_hash, p_user_id)
  on conflict (fingerprint_hash) do nothing;

  select user_id into owner
  from app_private.trial_card_fingerprints
  where fingerprint_hash = p_fingerprint_hash;

  return owner = p_user_id;
end;
$function$;

revoke all on function public.claim_trial_card(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_trial_card(uuid, text) to service_role;

commit;
