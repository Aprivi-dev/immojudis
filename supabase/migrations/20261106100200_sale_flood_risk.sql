begin;

set local lock_timeout = '5s';

-- Risque d'inondation de chaque vente (règle pepite-v2, compte-rendu
-- docs/equipe/2026-10-26-pepite-v2-inondation-loyers.md, proposition n° 4). Table PRIVÉE alimentée par le
-- traitement planifié /api/cron/sale-flood-risk (src/lib/sale-flood-risk-batch.ts) : TRI (API Géorisques
-- tri_zonage) et périmètre PPRi (servitude PM1 du Géoportail de l'urbanisme) au point de la vente. Le calcul des
-- pépites (/api/cron/sale-pepites) lit CE verdict et ne fait jamais d'appel réseau.
--
-- VERDICT (src/lib/flood-risk.ts, deriveFloodVerdict) :
--   high        position précise dans la zone du scénario « forte probabilité » (crue fréquente) d'un TRI : EXCLUT ;
--   exposed     position précise hors zone TRI mais dans le périmètre d'un PPRi : affichage seul, n'exclut pas ;
--   none_found  position précise, ni zone ni périmètre ;
--   no_signal   position imprécise dans une commune SANS TRI : la vente reste admissible ;
--   unknown     position imprécise dans une commune AVEC un TRI, commune inconnue, tampon de rue à cheval sur la
--               limite de la zone, ou jamais observée : aucune nouvelle pépite.
--
-- RAFRAÎCHISSEMENT : tous les 90 jours et dès que la position ou sa précision change (position_key). Une source en
-- panne n'écrase JAMAIS un verdict connu : seule la tentative est consignée (attempted_at, failure_count,
-- last_failure). La dernière valeur valable reste utilisée 180 jours (observed_at, lu par effectiveFloodVerdict).
--
-- MINIMISATION : aucune coordonnée n'est copiée ici. position_key est une empreinte (16 caractères d'un SHA-256 des
-- coordonnées arrondies à 1 m) qui sert seulement à reconnaître que la position a changé ; c'est une
-- pseudonymisation (l'empreinte se recalcule à partir d'une position connue), non une anonymisation ; la ligne ne porte ni
-- adresse, ni URL d'appel, ni réponse de la source (last_failure ne garde qu'un code : http_503, timeout…).
--
-- DROITS : sur le modèle d'auction_sale_pepites (20261104100000) : RLS activée, aucun droit pour anon ni
-- authenticated, lecture et écriture par le rôle de service. Aucune fonction publique ne lit cette table : le seul
-- fait public (« exposé ») passe par list_public_pepite_flood_exposed_ids (20261106100400), qui ne rend que des
-- identifiants de pépites publiables. La table suit la vente : suppression en cascade avec elle
-- (public.purge_expired_auction_sales supprime la vente, donc cette ligne).
--
-- DÉPLOIEMENT : le code applicatif fonctionne avant cette migration (le traitement se termine sans rien faire,
-- skipped "not_migrated") ; la règle v2 est derrière l'interrupteur PEPITE_RULE_V2_ENABLED (fermé par défaut), donc
-- rien ne change pour les pépites tant que le traitement n'est pas alimenté et calibré.
--
-- RETOUR ARRIÈRE (migration de retour arrière revue) : fermer PEPITE_RULE_V2_ENABLED, retirer le job
-- immojudis-sale-flood-risk et l'entrée ('sale-flood-risk', interval '3 hours') de cron.stale (voir 20261106100300),
-- puis drop table public.auction_sale_flood_risk.

create table if not exists public.auction_sale_flood_risk (
  sale_id uuid primary key references public.auction_sales(id) on delete cascade,
  verdict text not null check (verdict in ('high', 'exposed', 'none_found', 'no_signal', 'unknown')),
  derive_version text not null check (length(btrim(derive_version)) > 0),
  position_key text not null check (length(btrim(position_key)) > 0),
  position_kind text not null check (position_kind in ('point', 'street', 'approximate')),
  commune_insee text check (commune_insee is null or commune_insee ~ '^[0-9][0-9AB][0-9]{3}$'),
  commune_has_tri boolean,
  tri_scenarios jsonb not null default '[]'::jsonb check (jsonb_typeof(tri_scenarios) = 'array'),
  ppri_perimeter boolean,
  ppri_checked boolean not null default true,
  map_date date,
  observed_at timestamptz,
  attempted_at timestamptz not null default now(),
  failure_count integer not null default 0 check (failure_count >= 0),
  last_failure text check (last_failure is null or last_failure ~ '^[a-z0-9_]{1,40}$'),
  verdict_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Un verdict connu vient d'une observation réussie : seul « inconnu » peut n'en avoir jamais eu.
  constraint auction_sale_flood_risk_known_requires_observation check (
    verdict = 'unknown' or observed_at is not null
  )
);

comment on table public.auction_sale_flood_risk is
  'Verdict d''inondation de chaque vente (règle pepite-v2) : TRI forte probabilité et périmètre PPRi au point, alimenté par /api/cron/sale-flood-risk. Privé : aucun droit pour anon ni authenticated ; aucune coordonnée copiée. Supprimé avec la vente.';
comment on column public.auction_sale_flood_risk.verdict is
  'high (zone de crue fréquente d''un TRI : exclut), exposed (périmètre d''un PPRi : affichage seul), none_found, no_signal (position imprécise, commune sans TRI), unknown (aucune nouvelle pépite).';
comment on column public.auction_sale_flood_risk.derive_version is
  'Version de la dérivation du verdict (FLOOD_DERIVE_VERSION) : une autre version fait réobserver la vente.';
comment on column public.auction_sale_flood_risk.position_key is
  'Empreinte de la position observée (précision, drapeaux douteux, coordonnées arrondies à 1 m ou commune) : aucune coordonnée en clair, une empreinte tronquée (pseudonymisation). Un verdict ne vaut que pour cette position.';
comment on column public.auction_sale_flood_risk.position_kind is
  'point (adresse, parcelle), street (rue : tampon de cinq points) ou approximate (centre de commune, précision absente, drapeau de position douteuse).';
comment on column public.auction_sale_flood_risk.commune_insee is
  'Code commune (GASPAR) de la vente au moment de l''observation, d''après auction_sale_communes.';
comment on column public.auction_sale_flood_risk.commune_has_tri is
  'Position approximative seulement : la commune compte-t-elle un TRI ? (GASPAR ; nul quand la commune est inconnue ou non interrogée).';
comment on column public.auction_sale_flood_risk.tri_scenarios is
  'Codes de scénario rendus par tri_zonage, une liste par point testé (01For forte probabilité, 02Moy, 03Mcc, 04Fai) ; vide : hors zone.';
comment on column public.auction_sale_flood_risk.ppri_perimeter is
  'Le point est dans le périmètre d''un PPRi (servitude PM1, code_alea 11) ; nul quand la source n''a pas répondu.';
comment on column public.auction_sale_flood_risk.ppri_checked is
  'Faux quand le périmètre PPRi n''a pas pu être lu : la vente est réobservée après quelques heures.';
comment on column public.auction_sale_flood_risk.map_date is
  'Date de la carte du TRI (date_arrete_carte) quand l''API la donne.';
comment on column public.auction_sale_flood_risk.observed_at is
  'Dernière observation RÉUSSIE ; nul : jamais observée. Le verdict reste utilisé 180 jours après cette date.';
comment on column public.auction_sale_flood_risk.attempted_at is
  'Dernière tentative, réussie ou non.';
comment on column public.auction_sale_flood_risk.failure_count is
  'Échecs consécutifs depuis la dernière observation réussie ; un échec ne modifie jamais le verdict.';
comment on column public.auction_sale_flood_risk.last_failure is
  'Code du dernier échec (http_503, timeout, network…) : jamais une URL, une coordonnée ni un message de la source.';
comment on column public.auction_sale_flood_risk.verdict_changed_at is
  'Dernier changement de verdict : une pépite publiée dont le verdict a changé après son évaluation est réévaluée en priorité.';

alter table public.auction_sale_flood_risk enable row level security;

revoke all on table public.auction_sale_flood_risk from public, anon, authenticated;
grant select, insert, update on table public.auction_sale_flood_risk to service_role;

drop policy if exists auction_sale_flood_risk_service_role on public.auction_sale_flood_risk;
create policy auction_sale_flood_risk_service_role
  on public.auction_sale_flood_risk
  for all to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
