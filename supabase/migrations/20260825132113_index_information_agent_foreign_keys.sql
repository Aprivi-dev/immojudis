begin;

-- Version aligned with the migration recorded on the production project.

create index if not exists information_agent_cases_created_by_idx
  on public.information_agent_cases (created_by);
create index if not exists information_agent_cases_initiator_mission_idx
  on public.information_agent_cases (initiator_mission_id)
  where initiator_mission_id is not null;

create index if not exists information_agent_email_templates_created_by_idx
  on public.information_agent_email_templates (created_by)
  where created_by is not null;
create index if not exists information_agent_email_templates_updated_by_idx
  on public.information_agent_email_templates (updated_by)
  where updated_by is not null;
create index if not exists information_agent_email_templates_published_by_idx
  on public.information_agent_email_templates (published_by)
  where published_by is not null;

create index if not exists information_agent_evidence_assets_sale_idx
  on public.information_agent_evidence_assets (sale_id);
create index if not exists information_agent_evidence_extractions_message_idx
  on public.information_agent_evidence_extractions (message_id);
create index if not exists information_agent_evidence_extractions_sale_idx
  on public.information_agent_evidence_extractions (sale_id);

create index if not exists information_agent_fact_candidates_case_idx
  on public.information_agent_fact_candidates (case_id);
create index if not exists information_agent_fact_candidates_reviewed_by_idx
  on public.information_agent_fact_candidates (reviewed_by)
  where reviewed_by is not null;
create index if not exists information_agent_fact_candidates_sale_idx
  on public.information_agent_fact_candidates (sale_id);

create index if not exists information_agent_messages_user_idx
  on public.information_agent_messages (user_id)
  where user_id is not null;
create index if not exists information_agent_missions_case_idx
  on public.information_agent_missions (case_id)
  where case_id is not null;
create index if not exists information_agent_missions_sale_idx
  on public.information_agent_missions (sale_id)
  where sale_id is not null;

commit;
