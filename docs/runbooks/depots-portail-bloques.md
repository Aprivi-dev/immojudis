# Dépôts du portail de l'agent d'information bloqués

Le portail de dépôt (`/contribuer/<mission>`, lien signé reçu par le professionnel) permet de déposer des
pièces dans le bucket privé `information-agent-evidence`. Ce runbook sert quand un professionnel ne peut plus
déposer, ou quand des objets s'accumulent. Les requêtes ci-dessous sont en lecture seule ; toute écriture est
une action du propriétaire (`service_role`).

## Comment un dépôt fonctionne

1. `prepareInformationAgentContributionUpload` (`src/lib/information-agent-contribution.ts`) vérifie le lien
   (jeton lié à la mission, mission et dossier encore ouverts), limite à **16 préparations par dossier et par
   24 heures**, puis **libère les réservations expirées** du dossier.
2. Il crée une URL de dépôt signée (valable **2 heures**) et **réserve** la place dans
   `information_agent_portal_upload_reservations` (`public.reserve_information_agent_portal_upload`).
3. Le navigateur dépose l'objet dans Storage, puis valide : la réservation passe à `consumed`
   (`consume_information_agent_portal_upload`) et une ligne d'`information_agent_evidence_assets` est créée.
4. Une réservation jamais validée reste `reserved` ; une fois expirée depuis plus de **15 minutes**, elle est
   libérée (`released`) **à la prochaine préparation de dépôt pour ce dossier**, après suppression de l'objet
   orphelin du stockage. Si la suppression échoue, la réservation reste comptée (elle ne rouvre pas la
   capacité à l'aveugle).
5. Les objets orphelins que l'application n'a pas retirés sont mis en file par
   `enqueue_orphan_information_agent_portal_uploads` 24 heures après leur création, puis supprimés par
   `/api/cron/sale-retention` (voir `docs/data-retention-matrix.md`).

## Quota par dossier

Au plus **12 fichiers** et **480 Mo** par dossier. Chaque réservation `reserved` ou `consumed` compte
**40 Mo** (la limite du bucket), quelle que soit la taille réelle du fichier ; une réservation `released` ne
compte plus. Douze réservations suffisent donc à fermer le dépôt, y compris si onze n'ont jamais été validées.

## Symptômes

| Message ou code vu par le professionnel                                                         | Cause                                                                                                |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| « La capacité de dépôt de ce dossier est atteinte (12 fichiers) » (HTTP 413)                    | 12 réservations `reserved` ou `consumed` (`INFORMATION_AGENT_PORTAL_QUOTA_EXCEEDED`)                 |
| « Limite de dépôts atteinte pour ce dossier » (HTTP 429)                                        | 16 préparations en 24 heures pour le dossier                                                         |
| « Cette autorisation de fichier n'est plus valide. Recommencez le dépôt » (HTTP 409)            | réservation expirée, introuvable ou fichier différent de celui réservé                               |
| « Ce dossier n'accepte plus de dépôt » (HTTP 410)                                               | mission ou dossier fermé (hors `sending`, `sent`, `replied`, `review`), ou vente purgée              |
| « Lien de dépôt invalide ou expiré » (HTTP 404), ou « Ce brouillon est trop ancien » (HTTP 410) | jeton faux, mission supprimée, ou brouillon dont le jeton n'est plus valable                         |
| Erreur générale à la préparation                                                                | Storage indisponible, ou `INFORMATION_AGENT_PORTAL_SECRET` absent ou trop court (moins de 32 octets) |

Un dossier supprimé avec sa vente (24 heures après la vente, par la purge des ventes) supprime ses
réservations en cascade : le lien ne fonctionne plus, c'est voulu.

## Diagnostic

Retrouver le dossier : `information_agent_missions.case_id` de la mission du lien (`/contribuer/<mission>`).

```sql
-- Répartition des réservations du dossier
select status, count(*) as reservations, sum(size_bytes) as quota_bytes,
       min(expires_at) as plus_ancienne_expiration
from public.information_agent_portal_upload_reservations
where case_id = '<case_id>'
group by status;

-- Réservations qui bloquent : « reserved » dont le lien est expiré depuis plus de 15 minutes
select id, storage_path, created_at, expires_at
from public.information_agent_portal_upload_reservations
where case_id = '<case_id>' and status = 'reserved' and expires_at < now() - interval '15 minutes'
order by created_at;

-- Objets en attente de suppression (file durable de la purge)
select bucket, count(*), min(created_at) as plus_ancien
from public.sale_retention_storage_queue
group by bucket;
```

- `reserved` expirées en nombre : elles se libèrent d'elles-mêmes à la **prochaine** préparation de dépôt, si
  la suppression Storage réussit. Si elles ne se libèrent jamais, la suppression des objets échoue : voir les
  journaux Vercel de la route de préparation (erreur du `remove` Storage) et l'état de Storage.
- `consumed` = 12 : le dossier est réellement plein (pièces validées). Ce n'est pas un blocage à corriger ; le
  professionnel peut répondre à l'e-mail reçu (le message du portail le lui dit).
- File `sale_retention_storage_queue` qui grossit ou est ancienne : `/api/cron/sale-retention` ne passe pas ou
  échoue ; son job (`operational_job_runs`, `job_name = 'sale-retention'`) donne l'erreur par étape (purge des
  ventes, dépôts orphelins, vidange Storage).
- 429 : attendre la fin de la fenêtre de 24 heures ; ne pas contourner la limite.

## Actions (propriétaire)

- Réservations `reserved` expirées qui ne se libèrent pas et dont l'objet n'existe plus dans Storage :
  vérifier d'abord dans Storage (`information-agent-evidence/<case_id>/portal/…`) ; si l'objet est absent,
  passer la réservation à `released` :
  ```sql
  update public.information_agent_portal_upload_reservations
  set status = 'released'
  where id = '<id>' and status = 'reserved' and expires_at < now() - interval '15 minutes';
  ```
  Ne jamais supprimer la ligne d'une réservation `consumed` (elle rattache une pièce validée) ni libérer une
  réservation dont l'objet existe encore dans Storage (la capacité serait rouverte à l'aveugle).
- Besoin de faire de la place pour un dossier plein de pièces validées : décision d'exploitation, pas de
  correction technique ; demander au professionnel de répondre par e-mail.
- `INFORMATION_AGENT_PORTAL_SECRET` : le remplacer invalide tous les liens de dépôt déjà envoyés ; ne le faire
  qu'en cas de compromission.

## Fermeture

Une nouvelle préparation de dépôt réussit pour le dossier (le professionnel peut déposer), la répartition des
réservations est cohérente (`reserved` récentes seulement) et la file Storage se vide.
