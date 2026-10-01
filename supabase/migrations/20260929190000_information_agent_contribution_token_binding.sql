begin;

-- The application now verifies only the v2 payload, so links issued before
-- this migration are intentionally invalid and must be reissued.
alter table public.information_agent_missions
  add column if not exists contribution_token_version bigint not null default 1;

alter table public.information_agent_missions
  drop constraint if exists information_agent_missions_contribution_token_version_check;
alter table public.information_agent_missions
  add constraint information_agent_missions_contribution_token_version_check check (
    contribution_token_version between 1 and 9223372036854775807
  );

comment on column public.information_agent_missions.contribution_token_version is
  'Monotonic contribution-link generation. It changes when the mission recipient or shared case changes.';

create or replace function app_private.bump_information_agent_contribution_token_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contribution_token_version is null
     or new.contribution_token_version < old.contribution_token_version then
    new.contribution_token_version := old.contribution_token_version;
  end if;

  if new.case_id is distinct from old.case_id
     or lower(btrim(new.recipient_email)) is distinct from lower(btrim(old.recipient_email)) then
    if old.contribution_token_version = 9223372036854775807 then
      raise exception using
        errcode = '22003',
        message = 'Information-agent contribution token version exhausted.';
    end if;
    new.contribution_token_version := old.contribution_token_version + 1;
  end if;

  return new;
end;
$$;

revoke all on function app_private.bump_information_agent_contribution_token_version()
from public, anon, authenticated;

drop trigger if exists information_agent_missions_contribution_token_version
on public.information_agent_missions;
create trigger information_agent_missions_contribution_token_version
before update
on public.information_agent_missions
for each row
execute function app_private.bump_information_agent_contribution_token_version();

notify pgrst, 'reload schema';

commit;
