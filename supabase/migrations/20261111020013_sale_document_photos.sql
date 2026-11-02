-- Photos du bien trouvées dans les pièces jointes des ventes (cahier des conditions de vente, procès-verbal
-- descriptif...). Exemple : la vente des Cessions de l'État au 66 rue Lafaurie de Monbadon à Bordeaux montre une
-- photo sur sa page, son cahier des charges en contient neuf (façade, rue, pièces, escalier, cour).
--
-- Le passage borné `python -m src.pdf_photos` (services/data-pipeline/src/pdf_photos.py) télécharge ces PDF,
-- en extrait les photos dans un sous-processus sans secret (cartes, logos et schémas écartés), les ré-encode en
-- WebP 640 px et 1600 px et les dépose dans le bucket public `sale-photos`, sous `documents/{sale_id}/`.
--
-- * `public.sale_document_photos` : une ligne par photo retenue (une même image n'est gardée qu'une fois par
--   vente : `unique (sale_id, image_sha256)`). Fermée aux rôles du navigateur ; la galerie la lit par
--   `app_private.sale_document_photo_media` (migration suivante), fonction SECURITY DEFINER.
-- * `public.sale_document_photo_scans` : une ligne par pièce jointe examinée, avec ou sans photo, pour qu'un
--   document sans photo ne soit pas relu à chaque passage (échecs retentés 3 fois au plus, à 12 h d'écart).
-- * Purge : la suppression d'une photo (directe, ou en cascade quand la vente est purgée) place ses fichiers dans
--   `sale_retention_storage_queue`, la file que /api/cron/sale-retention vide avec l'API Storage, exactement
--   comme pour `sale_photos` (20261026100000). Ces lignes ne vivent pas dans `sale_photos` : le nettoyage des
--   copies périmées de src/photo_mirror.py (lignes dont `source_url` n'est plus la photo principale) ne les
--   touche donc jamais.
begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Photos
-- ---------------------------------------------------------------------------------------------
create table public.sale_document_photos (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  document_url text not null check (document_url ~* '^https?://'),
  image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  page_number integer not null check (page_number between 1 and 10000),
  position integer not null check (position between 1 and 100000),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  path_640 text not null,
  path_1600 text not null,
  -- URL publique du fichier 1600 px, sous la forme que le site emploie déjà pour les copies
  -- (`{SUPABASE_URL}/storage/v1/object/public/sale-photos/{chemin}`, src/lib/photo-mirror.ts). La base ne
  -- connaît pas l'adresse du projet : le pipeline l'écrit, la contrainte vérifie qu'elle désigne bien path_1600.
  public_url text not null,
  status text not null default 'stored' check (status in ('stored', 'withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_document_photos_sale_image_key unique (sale_id, image_sha256),
  constraint sale_document_photos_paths_check check (
    path_640 ~ '^documents/[0-9a-f-]{36}/[0-9a-f]{16}-640[.]webp$'
    and path_1600 ~ '^documents/[0-9a-f-]{36}/[0-9a-f]{16}-(640|1600)[.]webp$'
    and split_part(path_640, '/', 2) = sale_id::text
    and split_part(path_1600, '/', 2) = sale_id::text
  ),
  -- Le premier terme écarte une adresse sans origine (substring rendrait null et la contrainte passerait).
  constraint sale_document_photos_public_url_check check (
    public_url ~ '^https?://[^/?#]+/storage/v1/object/public/sale-photos/documents/'
    and public_url = substring(public_url from '^https?://[^/?#]+')
      || '/storage/v1/object/public/sale-photos/' || path_1600
  )
);

create index sale_document_photos_document_idx
  on public.sale_document_photos (sale_id, document_url, position);

comment on table public.sale_document_photos is
  'Photos du bien extraites des pièces jointes d''une vente (WebP 640 px et 1600 px, sans métadonnée, bucket sale-photos sous documents/{sale_id}/). Écrite par src/pdf_photos.py avec la clé service ; lue par la galerie via app_private.sale_document_photo_media(). status = withdrawn : retirée à la main, masquée aussitôt, ligne supprimée (et fichiers mis en file de purge) au passage suivant.';
comment on column public.sale_document_photos.image_sha256 is
  'Empreinte du flux image brut du PDF. Sert au nom des fichiers et au dédoublonnage par vente.';
comment on column public.sale_document_photos.position is
  'Rang d''apparition de l''image dans le document (pages dans l''ordre, puis de haut en bas), à partir de 1.';

alter table public.sale_document_photos enable row level security;
revoke all on table public.sale_document_photos from public, anon, authenticated;
grant select, insert, update, delete on table public.sale_document_photos to service_role;

-- ---------------------------------------------------------------------------------------------
-- Pièces jointes examinées
-- ---------------------------------------------------------------------------------------------
create table public.sale_document_photo_scans (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  document_url text not null,
  status text not null check (status in ('done', 'failed', 'blocked', 'gone', 'withdrawn', 'skipped')),
  reason text check (reason is null or char_length(reason) <= 200),
  attempts integer not null default 0 check (attempts >= 0),
  pages integer check (pages is null or pages >= 0),
  images integer check (images is null or images >= 0),
  photos_stored integer not null default 0 check (photos_stored >= 0),
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_document_photo_scans_sale_document_key unique (sale_id, document_url)
);

create index sale_document_photo_scans_status_idx on public.sale_document_photo_scans (status);

comment on table public.sale_document_photo_scans is
  'Une ligne par pièce jointe dont src/pdf_photos.py a cherché les photos : done (lue, avec ou sans photo), failed (retentée 3 fois au plus, à 12 h d''écart), blocked, gone, withdrawn, skipped. Service role seulement.';

alter table public.sale_document_photo_scans enable row level security;
revoke all on table public.sale_document_photo_scans from public, anon, authenticated;
grant select, insert, update, delete on table public.sale_document_photo_scans to service_role;

-- ---------------------------------------------------------------------------------------------
-- Purge des fichiers : file d'attente de la rétention (même règle que sale_photos)
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.enqueue_sale_document_photo_files_for_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `union` écarte le doublon quand path_640 = path_1600 (image étroite, un seul fichier). Un fichier qu'une
  -- autre photo `stored` de la même vente référence encore reste en place. Quand toute la vente est supprimée,
  -- les photos partent ensemble (cascade) et aucune n'en retient une autre : tout est mis en file.
  insert into public.sale_retention_storage_queue (bucket, object_path)
  select 'sale-photos', file.object_path
    from (
      select old.path_640 as object_path
      union
      select old.path_1600
    ) file
   where nullif(file.object_path, '') is not null
     and not exists (
       select 1
         from public.sale_document_photos other
        where other.sale_id = old.sale_id
          and other.id <> old.id
          and other.status = 'stored'
          and file.object_path in (other.path_640, other.path_1600)
     )
  on conflict (bucket, object_path) do nothing;
  return old;
end;
$$;

revoke all on function app_private.enqueue_sale_document_photo_files_for_deletion()
  from public, anon, authenticated;

create trigger sale_document_photos_enqueue_files_after_delete
after delete on public.sale_document_photos
for each row execute function app_private.enqueue_sale_document_photo_files_for_deletion();

notify pgrst, 'reload schema';

commit;
