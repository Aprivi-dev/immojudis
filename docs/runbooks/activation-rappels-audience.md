# Rappels d'audience : activation mesurée (`off` → `internal` → `on`)

Les rappels d'audience (email 7 jours puis la veille de l'audience d'une vente suivie) et les
avertissements graves (date modifiée, vente retirée, reportée, annulée ou adjugée) ne s'ouvrent pas d'un
coup : une date fausse envoyée à des centaines de personnes ne se rattrape pas. Ce document fixe **le
critère écrit de passage à `on`**, comment le mesurer et comment revenir en arrière. Le fonctionnement du
cron est dans `docs/operations/planification.md`, le code dans `src/lib/sale-reminders.ts`.

## Les trois modes (`SALE_REMINDERS_MODE`, variable Vercel)

| Valeur         | Ce qui se passe                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (défaut) | Le passage réussit sans rien lire ni envoyer. La case de consentement n'est proposée à personne (on ne recueille pas de consentement pour un envoi qui n'a pas lieu).                           |
| `internal`     | Le passage écrit **aux seuls administrateurs** qui ont consenti (objet préfixé « [Test interne] »). Eux seuls voient la case. Le journal `sale_reminder_dispatches` garde ce qui a été annoncé. |
| `on`           | Le passage écrit à **toutes** les personnes ayant consenti. La case est proposée à tous les comptes connectés.                                                                                  |

Une valeur inconnue vaut `off`. Changer de mode = modifier la variable dans Vercel puis redéployer. Aucune
migration, aucune écriture dans les comptes : le consentement déjà donné reste enregistré quel que soit le
mode.

## Avant de passer à `internal`

1. Appliquer les migrations `20261029130000_sale_reminders_consent_proof.sql` (déclencheur qui pose les
   dates de consentement et la version du texte) et `20261029130100_sale_reminder_dispatch_error_codes.sql`
   (codes d'échec courts). Sans la première, la route de consentement écrit une colonne qui n'existe pas.
2. Vérifier `RESEND_API_KEY`, `ALERT_EMAIL_FROM` et `SITE_URL` (sinon le passage réussit avec
   `skipped: not_configured`).
3. Au moins un administrateur coche « Me prévenir par email : rappel 7 jours avant puis la veille de l'audience… » dans `/compte` ou dans « Mon dossier » d'une
   vente suivie dont l'audience tombe dans les 7 prochains jours.

## Ce que l'on mesure en `internal`

Pendant la période d'essai, quatre mesures (la première décide, les autres sont des garde-fous) :

1. **Rappels contredits.** Un rappel J-7 ou J-1 est contredit quand la date d'audience de la vente change
   vers **un autre jour** (jour civil de Paris ; un changement d'heure le même jour ne compte pas) dans les
   **72 heures** qui suivent son envoi. Taux = rappels contredits / rappels envoyés dont ces 72 heures sont
   écoulées, sur 30 jours glissants. Calcul : `loadSaleReminderAccuracy` /
   `getAdminSaleReminderAccuracy` (`src/lib/admin-pilotage.ts`), qui lit `sale_reminder_dispatches` et
   `user_sale_change_events`. Résultat : `measuredReminders`, `contradictedReminders`,
   `contradictionRate`, `verdict` (`met`, `not_met`, `insufficient_sample`, `unavailable`).
2. **Rappels écartés faute de vérification récente.** Le passage n'envoie pas de J-7 ni de J-1 si la
   vente n'a pas été revérifiée à la source depuis 36 h (`skippedStale` dans le compte-rendu du cron) et
   il échoue si plus de 20 % des rappels dus sont écartés.
3. **Envois en échec** (`emailsFailed`) : codes courts dans la colonne `error` du journal
   (`email_unavailable`, `email_lookup_failed`, `message_build_failed`, `send_failed`, `journal_failed`).
4. **Personnes dont plus de 300 ventes tombent dans la fenêtre** (`truncatedUsers`) : doit rester à 0.

### Lire le taux sans la page de pilotage

Tant que la page « Pilotage » n'affiche pas le tableau, la requête suivante (lecture seule, éditeur SQL
Supabase) donne les mêmes nombres :

```sql
with sent as (
  select dispatch.user_id, dispatch.sale_id, dispatch.sent_at
  from public.sale_reminder_dispatches dispatch
  where dispatch.status = 'sent'
    and dispatch.reminder_kind in ('audience_j7', 'audience_j1')
    and dispatch.sent_at >= now() - interval '30 days'
    and dispatch.sent_at <= now() - interval '72 hours'
)
select
  count(*) as rappels_mesures,
  count(*) filter (
    where exists (
      select 1
      from public.user_sale_change_events change
      where change.user_id = sent.user_id
        and change.sale_id = sent.sale_id
        and change.event_kind = 'audience_changed'
        and change.detected_at > sent.sent_at
        and change.detected_at <= sent.sent_at + interval '72 hours'
        and change.change_summary ->> 'previousValue' ~ '^\d{4}-\d{2}-\d{2}T'
        and change.change_summary ->> 'currentValue' ~ '^\d{4}-\d{2}-\d{2}T'
        and ((change.change_summary ->> 'previousValue')::timestamptz at time zone 'Europe/Paris')::date
          <> ((change.change_summary ->> 'currentValue')::timestamptz at time zone 'Europe/Paris')::date
    )
  ) as rappels_contredits
from sent;
```

## Critère de passage à `on`

Le passage à `on` est décidé par le propriétaire quand **toutes** les conditions suivantes sont réunies :

1. **Moins de 2 % de rappels contredits** par un changement de date dans les 72 h, **sur au moins 100
   rappels mesurés** (`verdict = met`). Sous 100 rappels, on ne conclut pas (`insufficient_sample`) : on
   attend ou on élargit l'essai, on n'assouplit pas le critère. Exactement 2 % ne passe pas.
2. **Aucun passage du cron `sale-reminders` en échec** pour cause de rappels écartés (plus de 20 % de
   `skippedStale`) ou d'envois en échec (`emailsFailed`) sur les 14 derniers jours, et aucune alerte
   `cron.stale` ouverte sur `sale-reminders` et `sale-change-monitor` (le suivi des changements nourrit
   les avertissements : un suivi en panne rend les avertissements muets).
3. **`truncatedUsers` à 0** sur les 14 derniers jours.
4. **La désinscription fonctionne de bout en bout** : un administrateur a utilisé le lien de désinscription
   d'un email de test (« Me désinscrire des rappels »), et la personne ne reçoit plus rien. Le lien reste
   valable un an.
5. **Le texte de consentement est figé** : la version `SALE_REMINDERS_CONSENT_TEXT_VERSION`
   (`src/lib/notification-preferences.ts`) est celle qui sera présentée aux utilisateurs. Toute
   modification du libellé de la case change cette version.

Si le critère 1 n'est pas atteint (taux trop élevé), on ne passe pas à `on` : on cherche d'où viennent les
dates contredites (source instable, date lue puis corrigée) et on corrige la collecte ou le seuil de
fraîcheur, pas le critère.

## Passer à `on`, surveiller, revenir en arrière

1. Dans Vercel, `SALE_REMINDERS_MODE=on`, puis redéployer.
2. Les trois premiers jours, regarder chaque matin le compte-rendu du cron (`sale-reminders`) : personnes
   écrites, `emailsFailed`, `skippedStale`, `truncatedUsers`, et le taux de rappels contredits.
3. **Retour arrière immédiat** : `SALE_REMINDERS_MODE=internal` (ou `off`) puis redéploiement. Aucun
   nettoyage : les consentements sont conservés, le journal empêche tout renvoi des rappels déjà
   envoyés.
