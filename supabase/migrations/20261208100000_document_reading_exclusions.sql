-- 20261208100000 : ventes exclues de la lecture automatique des pièces (lot V3b-0).
--
-- Une vente inscrite ici n'est plus lue par aucun modèle : ni le banc de lecture des pièces
-- (services/data-pipeline/scripts/compare_document_vision.py), ni la passe d'écriture du lot V3b-1. La seule
-- lecture côté pipeline est src/document_reading_exclusions.py (une fonction et un fragment SQL partagé).
--
-- Clé : l'URL source de la vente (auction_sales.source_url). Elle reste stable quand la vente absorbe un doublon,
-- et le pipeline la cherche aussi dans source_urls : une vente exclue puis absorbée par une autre l'exclut avec elle.
-- Motif : liste fermée (opposition, correction, autre). La demande d'exercice des droits, si elle existe, est
-- nommée par son identifiant ; sa purge (5 ans après sa clôture) ne supprime pas l'exclusion.
-- Aucune donnée personnelle : ni nom, ni adresse, ni texte libre.
--
-- Accès : rôle de service seul. RLS activée sans politique, aucun droit pour public, anon ni authenticated.
-- Inscription par la commande opérateur `python -m scripts.exclude_sale_from_document_reading` (connexion
-- directe). Pas de purge automatique : une exclusion qui disparaîtrait laisserait la lecture reprendre.
--
-- Retour arrière : `drop table public.document_reading_exclusions;` (le pipeline lit alors une table absente et
-- s'arrête avant toute lecture : à faire seulement avec le code qui ne la lit plus).
begin;

create table if not exists public.document_reading_exclusions (
  source_url text primary key check (char_length(source_url) between 8 and 2000),
  reason text not null check (reason in ('opposition', 'correction', 'autre')),
  data_subject_request_id uuid references public.data_subject_requests (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.document_reading_exclusions is
  'Ventes (URL source) exclues de toute lecture automatique des pièces par un modèle : opposition, correction ou autre motif. Rôle de service seul. Sans purge automatique.';

create index if not exists document_reading_exclusions_request_idx
  on public.document_reading_exclusions (data_subject_request_id)
  where data_subject_request_id is not null;

alter table public.document_reading_exclusions enable row level security;
revoke all on table public.document_reading_exclusions from public, anon, authenticated;
grant select, insert on table public.document_reading_exclusions to service_role;

commit;
