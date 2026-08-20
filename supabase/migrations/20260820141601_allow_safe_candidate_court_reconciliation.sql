begin;

create or replace function app_private.catalogue_bridge_court_is_reconcilable(
  p_bridge_id uuid,
  p_target_court_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.auction_sale_outcome_bridges bridge
    join public.auction_sales sale_row on sale_row.id = bridge.auction_sale_id
    join public.outcome_courts target_court on target_court.id = p_target_court_id
    join public.auction_outcomes unknown_outcome
      on unknown_outcome.id = bridge.unknown_outcome_id
      and unknown_outcome.round_id = bridge.round_id
      and unknown_outcome.outcome_status = 'unknown'
      and not unknown_outcome.training_eligible
    where bridge.id = p_bridge_id
      and target_court.code = coalesce(
        app_private.auction_sale_verified_court_code(sale_row),
        'legacy:unmapped'
      )
      and bridge.catalogue_status = 'announced'
      and bridge.outcome_status = 'unknown'
      and not bridge.training_eligible
      and not exists (
        select 1 from public.auction_feature_snapshots snapshot_row
        where snapshot_row.round_id = bridge.round_id
      )
      and not exists (
        select 1 from public.auction_predictions prediction_row
        where prediction_row.round_id = bridge.round_id
      )
      and not exists (
        select 1 from public.tribunal_statistics_members member_row
        where member_row.round_id = bridge.round_id
      )
      and not exists (
        select 1
        from public.source_record_matches match_row
        join public.judicial_source_records record_row
          on record_row.id = match_row.source_record_id
        where (
          match_row.case_id = bridge.case_id
          or match_row.lot_id = bridge.lot_id
          or match_row.round_id = bridge.round_id
          or match_row.outcome_id = bridge.unknown_outcome_id
        ) and (
          match_row.status not in (
            'candidate', 'weak_candidate', 'review_required', 'strong_candidate'
          )
          or match_row.decided_at is not null
          or match_row.reviewer_user_id is not null
          or match_row.decision_notes is not null
          or match_row.supersedes_match_id is not null
          or record_row.training_eligible
          or match_row.match_method in ('court_name_address', 'address_date_court')
          or match_row.match_signals ? 'court'
          or exists (
            select 1
            from public.source_record_matches successor_row
            where successor_row.supersedes_match_id = match_row.id
          )
        )
      )
      and not exists (
        select 1 from public.auction_events event_row
        where event_row.round_id = bridge.round_id
          and event_row.id <> bridge.announcement_event_id
      )
      and not exists (
        select 1 from public.auction_outcomes outcome_row
        where outcome_row.round_id = bridge.round_id
          and outcome_row.id <> bridge.unknown_outcome_id
      )
      and not exists (
        select 1 from public.auction_outcome_evidence evidence_row
        where evidence_row.outcome_id = bridge.unknown_outcome_id
      )
      and not exists (
        select 1 from public.outcome_claim_eligibility_decisions decision_row
        where decision_row.outcome_id = bridge.unknown_outcome_id
      )
  );
$$;

comment on function app_private.catalogue_bridge_court_is_reconcilable(uuid, uuid) is
  'Allows a verified court correction only before derived evidence exists. Standalone, undecided, non-training source-match candidates may coexist when they contain no court signal; reviewed, superseding or court-dependent matches still block mutation.';

commit;
