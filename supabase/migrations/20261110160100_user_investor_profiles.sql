begin;

set local lock_timeout = '5s';

-- Profil d'investisseur enregistré sur le compte (n° 93 de la session du 31/10/2026, validé le 31/10/2026).
--
-- Quatre hypothèses que la personne choisit une fois et retrouve dans le calcul de l'enchère plafond de
-- chaque vente (elle les modifie vente par vente, comme avant) :
--   - apport personnel (euros), repris par le simulateur de financement ;
--   - marge cible (pourcentage), reprise par le calcul du plafond ;
--   - budget travaux au mètre carré (euros), converti en budget avec la surface de la vente ;
--   - stratégie : revendre ou louer.
-- Chaque valeur est facultative. Rien n'est déduit ni complété par le serveur : une valeur absente reste
-- absente, et le calcul retombe alors sur ses hypothèses de départ.
--
-- DONNÉE PERSONNELLE DE NATURE FINANCIÈRE (apport, objectifs de rendement) : table réservée à son
-- propriétaire, jamais lue pour un autre compte, ni par un écran d'administration, un email ou un
-- export. Voir docs/rgpd-processing-register.md et docs/data-retention-matrix.md.
--
-- Sécurité : une seule ligne par compte (clé primaire user_id). Comme toute table créée depuis le
-- 04/11/2026 (invariant de scripts/check-security-invariants.mjs), la table ne reçoit AUCUN droit pour
-- anon ni authenticated : seul le rôle de service y accède, par les routes de /api/investor-profile qui
-- authentifient le compte et filtrent chaque lecture, écriture et suppression sur son user_id. La
-- sécurité par ligne est activée en plus, avec des politiques « propriétaire seul » : si un droit était
-- un jour accordé par erreur à authenticated, un compte ne verrait ni ne modifierait que sa propre ligne.
-- La date de modification est posée par un déclencheur. L'effacement du compte l'emporte (on delete
-- cascade ; table ajoutée à ERASURE_TABLES dans src/lib/privacy-requests.ts).
--
-- Conservation : tant que le compte existe, ou jusqu'à ce que la personne vide son profil (bouton
-- « Effacer mon profil » de /compte).

create table if not exists public.user_investor_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  down_payment_eur numeric,
  target_margin_pct numeric,
  works_per_m2_eur numeric,
  strategy text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_investor_profiles_down_payment_check check (
    down_payment_eur is null or (down_payment_eur >= 0 and down_payment_eur <= 10000000000)
  ),
  -- Même borne que le calcul du plafond (marge entre 0 et 50 %, src/lib/bid-ceiling-engine.ts).
  constraint user_investor_profiles_target_margin_check check (
    target_margin_pct is null or (target_margin_pct >= 0 and target_margin_pct <= 50)
  ),
  constraint user_investor_profiles_works_per_m2_check check (
    works_per_m2_eur is null or (works_per_m2_eur >= 0 and works_per_m2_eur <= 10000)
  ),
  constraint user_investor_profiles_strategy_check check (
    strategy is null or strategy in ('revendre', 'louer')
  ),
  -- Une ligne sans aucune hypothèse n'a pas d'objet : on supprime le profil plutôt que de le vider.
  constraint user_investor_profiles_not_empty_check check (
    down_payment_eur is not null
    or target_margin_pct is not null
    or works_per_m2_eur is not null
    or strategy is not null
  )
);

comment on table public.user_investor_profiles is
  'Hypothèses d''investisseur d''un compte (apport, marge cible, travaux au m², stratégie), reprises dans le calcul de l''enchère plafond. Donnée personnelle financière : propriétaire seul (RLS), effacée avec le compte.';
comment on column public.user_investor_profiles.down_payment_eur is
  'Apport personnel en euros, facultatif.';
comment on column public.user_investor_profiles.target_margin_pct is
  'Marge cible en pourcentage (0 à 50), facultative.';
comment on column public.user_investor_profiles.works_per_m2_eur is
  'Budget travaux en euros par mètre carré (0 à 10 000), facultatif.';
comment on column public.user_investor_profiles.strategy is
  'Stratégie : revendre ou louer, facultative.';

-- La date de modification est posée par la base, jamais par le client.
create or replace function app_private.touch_investor_profile()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function app_private.touch_investor_profile() from public, anon, authenticated;

drop trigger if exists touch_investor_profile on public.user_investor_profiles;
create trigger touch_investor_profile
before insert or update on public.user_investor_profiles
for each row execute function app_private.touch_investor_profile();

alter table public.user_investor_profiles enable row level security;

revoke all on table public.user_investor_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.user_investor_profiles to service_role;

drop policy if exists user_investor_profiles_select_own on public.user_investor_profiles;
create policy user_investor_profiles_select_own
on public.user_investor_profiles for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists user_investor_profiles_insert_own on public.user_investor_profiles;
create policy user_investor_profiles_insert_own
on public.user_investor_profiles for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_investor_profiles_update_own on public.user_investor_profiles;
create policy user_investor_profiles_update_own
on public.user_investor_profiles for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists user_investor_profiles_delete_own on public.user_investor_profiles;
create policy user_investor_profiles_delete_own
on public.user_investor_profiles for delete
to authenticated
using (user_id = (select auth.uid()));

notify pgrst, 'reload schema';

commit;
