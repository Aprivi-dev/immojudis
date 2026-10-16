# Retirer une photo hébergée, ou toutes celles d'une source

Immojudis héberge une copie de la photo principale de chaque vente (test du 16/10/2026) : fichiers
WebP de 640 px et 1600 px dans le bucket public `sale-photos`, une ligne par photo dans
`public.sale_photos`. Ce runbook sert quand un titulaire de droits, une personne photographiée ou une
source demande que la copie disparaisse.

| Motif                              | Délai cible                                        |
| ---------------------------------- | -------------------------------------------------- |
| Droit d'auteur (titulaire ou site) | **72 heures** après réception de la demande        |
| RGPD (personne reconnaissable)     | **1 mois** au plus après réception (article 12 §3) |

Accuser réception tout de suite, noter la date de réception : c'est elle qui fait courir le délai.

## Ce qui existe

- `public.sale_photos` : `status` vaut `stored` (copie servie), `failed`, `gone`, `blocked` ou
  `withdrawn`. Seules les lignes `stored` sont lues par le site (`public.sale_photo_mirrors`). La ligne
  garde `sha256`, l'empreinte de l'original téléchargé.
- Une ligne `withdrawn` **empêche aussi la recopie** : le pipeline ne copie que les photos sans ligne
  (ou en échec récent). Supprimer la ligne autoriserait une nouvelle copie.
- Interrupteurs : variable de dépôt `PHOTO_MIRROR_ENABLED` (pipeline, `true` pour copier) et
  `NEXT_PUBLIC_PHOTO_MIRROR` (site, `on` pour afficher les copies). Ils arrêtent les copies et leur
  affichage, mais ne suppriment aucun fichier.
  - `PHOTO_MIRROR_ENABLED` à autre chose que `true` : plus aucun téléchargement ni copie, mais les
    retraits continuent (le pipeline les applique à chaque passage planifié, interrupteur éteint ou
    non : un retrait n'attend jamais la réactivation).
  - `NEXT_PUBLIC_PHOTO_MIRROR` est **intégrée au build** (préfixe `NEXT_PUBLIC_`) : changer sa valeur
    dans Vercel ne change rien tant que le site n'est pas **redéployé**. Pour couper l'affichage des
    copies, la vider (ou la mettre hors `on`) puis redéployer en production.
  - Même après le redéploiement, les pages en cache gardent les chemins des copies un moment : le
    cache des pages dure 300 s (5 minutes) et le navigateur des visiteurs 60 s. Compter donc environ
    6 minutes avant que plus personne ne reçoive l'ancien chemin.
  - Si le fichier a déjà disparu du bucket (retrait par la procédure ci-dessous), l'image copiée
    répond 404 et le site retombe sur l'URL de la source (lien direct) : pas d'image cassée, mais
    l'image de la source reste affichée (voir le paragraphe suivant).
- `public.sale_photo_mirrors` ne renvoie une copie que si sa vente est au catalogue public : une
  vente mise en quarantaine, terminée ou périmée cesse d'être servie (au plus 5 minutes après, cache
  compris), sans attendre sa purge.
- Les fichiers sont supprimés par `/api/cron/sale-retention` (toutes les 5 minutes), qui vide la file
  `public.sale_retention_storage_queue` avec l'API Storage. Le bucket doit figurer dans la liste
  blanche de `src/lib/sale-retention.ts` (`sale-photos` y est ; sans cela le cron s'arrête sur
  « Unexpected retention bucket » et ne vide plus aucun bucket).

Ce runbook retire **notre copie**. La fiche peut encore afficher l'image à partir de l'URL de la
source (lien direct). Si la demande vise aussi cet affichage, il faut en plus masquer l'image ou la
vente (procédure habituelle de retrait d'une annonce), ce que ce document ne fait pas.

## Retirer une photo

Les requêtes ci-dessous écrivent en production : elles se lancent à la main, dans l'éditeur SQL
Supabase (rôle `service_role`), par une personne habilitée. Jamais depuis un agent.

1. **Retrouver la photo.** Lecture seule :

   ```sql
   select p.id, p.sale_id, p.source_url, p.source_host, p.status, p.sha256, p.path_640, p.path_1600,
          (select count(*) from public.sale_photos o
            where o.id <> p.id and o.sale_id = p.sale_id and o.status = 'stored'
              and (o.path_640 in (p.path_640, p.path_1600) or o.path_1600 in (p.path_640, p.path_1600))
          ) as autres_copies_du_meme_fichier
   from public.sale_photos p
   where p.sale_id = '<sale_id>'            -- ou : p.source_url = '<url de la photo>'
   order by p.created_at;
   ```

   Une même photo publiée sous deux URL d'une vente donne **un seul fichier** (même vente, même
   empreinte), partagé par deux lignes. Si `autres_copies_du_meme_fichier` n'est pas 0 et que la
   demande vise l'image elle-même, retirer **toutes** les lignes qui la portent (filtrer par
   `sale_id` et `sha256` à l'étape 3) : sinon l'autre ligne continue de servir le fichier, qui
   reste en place.

2. **Garder la preuve minimale** (avant d'effacer quoi que ce soit), dans le registre des demandes
   de droits, **sans l'image** : empreinte `sha256`, identifiant de la vente, hôte de la source, date
   de réception de la demande, date du retrait, motif (droit d'auteur, RGPD, autre) et suite donnée.
   La ligne `sale_photos` garde `sha256` tant que la vente existe ; le registre garde la preuve
   après la purge de la vente.

3. **Retirer la copie.** Une seule transaction : la ligne passe en `withdrawn` (le site cesse de
   servir la copie dès cet instant), ses fichiers entrent dans la file de rétention et ses chemins
   sont effacés.

   ```sql
   begin;
   with target as (
     select id, path_640, path_1600
     from public.sale_photos
     where sale_id = '<sale_id>' and source_url = '<url de la photo>' and status = 'stored'
     for update
   ), queued as (
     -- Un fichier qu'une autre copie `stored` (hors de la sélection) utilise encore reste en place.
     insert into public.sale_retention_storage_queue (bucket, object_path)
     select distinct 'sale-photos', file.object_path
     from target, lateral (values (target.path_640), (target.path_1600)) as file(object_path)
     where file.object_path is not null
       and not exists (
         select 1 from public.sale_photos o
         where o.status = 'stored'
           and o.id not in (select id from target)
           and file.object_path in (o.path_640, o.path_1600)
       )
     on conflict (bucket, object_path) do nothing
   )
   update public.sale_photos photo
      set status = 'withdrawn', path_640 = null, path_1600 = null,
          bytes_640 = null, bytes_1600 = null, last_attempt_at = now()
     from target
    where photo.id = target.id;
   commit;
   ```

   Le pipeline fait la même chose tout seul à chaque passage planifié pour une source retirée du
   catalogue (voir plus bas), même quand `PHOTO_MIRROR_ENABLED` est éteint : pour une demande
   urgente, utiliser la requête ci-dessus sans attendre le passage suivant.

4. **Vérifier.** Attendre le passage du cron (5 minutes), puis :
   - `select count(*) from public.sale_retention_storage_queue where bucket = 'sale-photos';`
     revient à 0 (sinon lire le dernier appel de `/api/cron/sale-retention`) ;
   - l'ancienne URL publique `…/storage/v1/object/public/sale-photos/<chemin>` répond 404 ;
   - `select * from public.sale_photo_mirrors(array['<url de la photo>']);` ne renvoie rien.

5. **Répondre** au demandeur dans le délai cible, sans joindre l'image.

## Retirer toutes les photos d'une source

1. **Arrêter les nouvelles copies.** Au choix, du plus propre au plus brutal :
   - retirer la source du catalogue (`select public.set_catalogue_source_withdrawal('<source>', true, '<motif>')`,
     voir `services/data-pipeline/src/source_withdrawal.py`). Au début de chaque passage, le pipeline
     passe alors en `withdrawn` les copies de cette source et supprime leurs fichiers. Attention : il
     reconnaît les photos d'une source par `SOURCE_HOSTS` (aujourd'hui Licitor seulement) et par les
     ventes dont toutes les sources sont retirées ; pour une autre source, ajouter son hôte à
     `SOURCE_HOSTS` (modification de code) ou passer par la requête de l'étape 2 ;
   - ajouter l'hôte à `BLOCKED_HOSTS` dans `services/data-pipeline/src/photo_mirror.py` (modification
     de code : les photos de cet hôte prennent le statut `blocked` sans téléchargement) ;
   - repasser `PHOTO_MIRROR_ENABLED` à `false` (arrête toutes les sources ; les retraits
     continuent de s'appliquer).
2. **Retirer les copies déjà faites**, avec la requête de l'étape 3 ci-dessus en remplaçant le filtre
   du `where` de `target` par :

   ```sql
   where source_host in ('<hôte 1>', '<hôte 2>') and status = 'stored'
   ```

   (ou `source_host like '%.exemple.fr'` pour tous les sous-domaines). Les lignes en `failed` n'ont
   pas de fichier : les laisser.

3. **Garder la preuve minimale** : une ligne par source dans le registre (hôte, date de la demande,
   date du retrait, motif, nombre de photos retirées).
4. **Vérifier** comme à l'étape 4 ci-dessus.

## Rétablir une photo

Si la demande était infondée ou si la source a donné son accord par écrit, supprimer la ligne
`withdrawn` autorise une nouvelle copie. Attention : la nouvelle copie retombe sur **le même chemin**
(`{sale_id}/{16 premiers caractères du sha256}-640.webp`, même empreinte) que l'ancienne. Si ce
chemin attend encore dans `public.sale_retention_storage_queue` (retrait fait par la requête de
l'étape 3, cron pas encore passé), le cron effacerait le fichier tout juste recopié.

1. **Lire le chemin à surveiller** :

   ```sql
   select id, sale_id, left(sha256, 16) as prefixe
   from public.sale_photos where id = '<id>' and status = 'withdrawn';
   ```

2. **Attendre que la file soit vide pour ce chemin** (le cron passe toutes les 5 minutes) :

   ```sql
   select object_path from public.sale_retention_storage_queue
   where bucket = 'sale-photos' and object_path like '<sale_id>/<prefixe>-%';
   ```

   Tant que cette requête renvoie une ligne, ne pas supprimer la ligne `withdrawn`. Si la file ne se
   vide pas, lire le dernier appel de `/api/cron/sale-retention` (voir « Vérifier » plus haut) plutôt
   que de la vider à la main : retirer une entrée au moment où le cron l'a déjà lue ne sauve pas le
   fichier.

3. **Supprimer la ligne** (aucun fichier n'y est attaché, donc rien n'entre dans la file) :

   ```sql
   delete from public.sale_photos where id = '<id>' and status = 'withdrawn';
   ```

   Le prochain passage du pipeline recopie la photo (interrupteur `PHOTO_MIRROR_ENABLED` à `true`).

Garde du pipeline : avant d'écrire une copie, il vérifie que ses deux chemins ne sont pas dans la file
de rétention. S'ils y sont encore, il **reporte** la photo au passage suivant (aucune ligne écrite,
aucun fichier envoyé) : oublier l'étape 2 retarde donc la copie sans jamais la faire effacer.

## Ce qui part tout seul

- Vente purgée : la ligne `sale_photos` part en cascade, un déclencheur place ses fichiers (un seul
  si l'original faisait 640 px ou moins) dans `sale_retention_storage_queue`, et le cron les supprime.
- Photo principale changée : quand la `catalogue_thumbnail_url` d'une vente n'est plus l'URL d'une
  copie `stored`, chaque passage du pipeline (interrupteur allumé) supprime cette ligne, 300 au plus
  par passage ; ses fichiers entrent dans la file de rétention, sauf ceux qu'une autre copie de la
  vente utilise encore. Les lignes `withdrawn` ne sont jamais supprimées ainsi : elles empêchent la
  recopie.
- Fichier orphelin (copie interrompue) : le pipeline tente de le retirer lui-même ; sinon il se
  repère dans le bucket par un nom absent de `sale_photos.path_640` et `path_1600`.
