-- Test d'hébergement de la photo principale des ventes (décision du propriétaire du 16/10/2026).
--
-- * Bucket Storage public `sale-photos` : uniquement des WebP déjà ré-encodés (sans EXIF) par le
--   pipeline, 2 Mo au plus. Aucune politique sur storage.objects : le pipeline écrit avec la clé
--   service, les visiteurs lisent par l'URL publique d'un objet (jamais de liste).
-- * Table `public.sale_photos` : une ligne par (vente, URL source). Fermée aux rôles navigateur ;
--   le site lit uniquement par `public.sale_photo_mirrors(text[])`.
-- * Purge : la suppression d'une ligne (directe ou en cascade quand la vente est purgée) place ses
--   fichiers dans `sale_retention_storage_queue`, la file que /api/cron/sale-retention vide
--   avec l'API Storage (jamais en SQL). Un fichier qu'une autre copie `stored` de la vente utilise
--   encore n'est pas mis en file.
-- * Lecture : `sale_photo_mirrors` ne renvoie une copie que si sa vente est dans le catalogue public
--   (ni en quarantaine, ni terminée, ni périmée).
--
-- Écart assumé avec le contrat : `public.sale_photo_mirrors` n'est pas SECURITY DEFINER. Le test
-- 441_function_privileges.sql interdit toute fonction SECURITY DEFINER du schéma public exécutable
-- par anon. On suit le modèle de get_public_sale_calendar_event : fonction SECURITY DEFINER dans
-- `app_private`, enveloppe SECURITY INVOKER dans `public` avec la même signature.
begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sale-photos', 'sale-photos', true, 2097152, array['image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------
create table public.sale_photos (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  source_url text not null,
  source_host text not null,
  sha256 text,
  path_640 text,
  path_1600 text,
  width integer,
  height integer,
  bytes_640 integer,
  bytes_1600 integer,
  status text not null check (status in ('stored', 'failed', 'gone', 'blocked', 'withdrawn')),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  stored_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sale_photos_sale_source_key unique (sale_id, source_url),
  -- Une copie lisible a toujours ses deux chemins (identiques si l'original est étroit).
  constraint sale_photos_stored_has_files check (
    status <> 'stored' or (path_640 is not null and path_1600 is not null and sha256 is not null)
  )
);

create index sale_photos_status_idx on public.sale_photos (status);
create index sale_photos_source_url_idx on public.sale_photos (source_url);

comment on table public.sale_photos is
  'Copie hébergée (WebP 640 px et 1600 px, sans EXIF) de la photo principale d''une vente. Écrite par le pipeline avec la clé service ; lue par le site via sale_photo_mirrors().';
comment on column public.sale_photos.sha256 is
  'Empreinte de l''original téléchargé. Sert au nom des fichiers et de preuve minimale lors d''un retrait.';

alter table public.sale_photos enable row level security;
revoke all on table public.sale_photos from public, anon, authenticated;
grant select, insert, update, delete on table public.sale_photos to service_role;

-- ---------------------------------------------------------------------------------------------
-- Lecture publique, par URL source connue de l'appelant
-- ---------------------------------------------------------------------------------------------
create or replace function app_private.sale_photo_mirrors(p_source_urls text[])
returns table (source_url text, path_640 text, path_1600 text, width integer, height integer)
language sql
stable
security definer
set search_path = ''
as $function$
  -- Au plus 100 URL lues. Une même URL partagée par deux ventes ne renvoie qu'une ligne.
  -- Une copie n'est servie que tant que sa vente est dans le catalogue public : mise en quarantaine,
  -- terminée, périmée ou masquée (source retirée), la vente cesse d'être servie au plus tard au
  -- prochain rafraîchissement de cache du site. Prédicat identique à celui de la sélection des
  -- candidats du pipeline (photo_mirror.py) et de la recherche publique
  -- (search_auction_sales_preview_v4, 20261024100000), sans le prédicat d'indexation du sitemap.
  select distinct on (photo.source_url)
    photo.source_url, photo.path_640, photo.path_1600, photo.width, photo.height
  from public.sale_photos photo
  join public.auction_sales s on s.id = photo.sale_id
  where photo.status = 'stored'
    and photo.source_url = any (p_source_urls[1:100])
    and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and (
      case
        when s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null
          then s.catalogue_expiry_deadline > current_timestamp
        else app_private.sale_catalogue_entry_is_live_materialized(
          false,
          null,
          s.sale_date,
          s.raw_payload,
          s.sale_procedure
        )
      end
    )
    and not s.catalogue_quarantined
  order by photo.source_url, photo.stored_at desc nulls last, photo.id;
$function$;

revoke all on function app_private.sale_photo_mirrors(text[]) from public, anon, authenticated;
grant execute on function app_private.sale_photo_mirrors(text[])
  to anon, authenticated, service_role;

create or replace function public.sale_photo_mirrors(p_source_urls text[])
returns table (source_url text, path_640 text, path_1600 text, width integer, height integer)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from app_private.sale_photo_mirrors(p_source_urls);
$function$;

revoke all on function public.sale_photo_mirrors(text[]) from public;
grant execute on function public.sale_photo_mirrors(text[]) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Purge des fichiers : file d'attente de la rétention
-- ---------------------------------------------------------------------------------------------
alter table public.sale_retention_storage_queue
  drop constraint if exists sale_retention_storage_queue_bucket_check;
alter table public.sale_retention_storage_queue
  add constraint sale_retention_storage_queue_bucket_check
  check (bucket in ('information-agent-evidence', 'information-agent-approved', 'sale-photos'));

create or replace function app_private.enqueue_sale_photo_files_for_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `union` écarte le doublon quand path_640 = path_1600 (original étroit, un seul fichier).
  -- Un fichier qu'une autre copie `stored` de la même vente référence encore reste en place : la même
  -- photo sous deux URL donne le même chemin (même vente, même empreinte). Quand toute la vente est
  -- supprimée, les copies partent ensemble (cascade) et aucune n'en retient une autre : tout est mis
  -- en file.
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
         from public.sale_photos other
        where other.sale_id = old.sale_id
          and other.id <> old.id
          and other.status = 'stored'
          and file.object_path in (other.path_640, other.path_1600)
     )
  on conflict (bucket, object_path) do nothing;
  return old;
end;
$$;

revoke all on function app_private.enqueue_sale_photo_files_for_deletion()
  from public, anon, authenticated;

create trigger sale_photos_enqueue_files_after_delete
after delete on public.sale_photos
for each row execute function app_private.enqueue_sale_photo_files_for_deletion();

notify pgrst, 'reload schema';

commit;
