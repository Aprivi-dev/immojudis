# Emails d'alerte envoyés à tort

Objet : arrêter l'envoi des emails d'alerte (alertes enregistrées) en quelques minutes, puis traiter ce qui
est déjà en file. Public : le propriétaire (accès Vercel et éditeur SQL de Supabase).

À utiliser quand des emails d'alerte partent alors qu'ils ne devraient pas : mauvaise vente ou mauvais critère
(règle d'alerte fautive), contenu erroné, envoi à des personnes sans consentement, doublons. Les autres emails
ont leur propre interrupteur (`SALE_REMINDERS_MODE`, `WEEKLY_DIGEST_MODE`, `SALE_RESULTS_MODE`) : ce document ne
couvre que les alertes.

Dernier essai : jamais (à dater après un essai en préproduction).

## L'interrupteur `ALERT_NOTIFICATIONS_MODE`

Lu à chaque passage de `/api/cron/alert-notifications` (`src/lib/email-feature-mode.ts`).

| Valeur                     | Emails d'alerte                       | Notifications dans l'application |
| -------------------------- | ------------------------------------- | -------------------------------- |
| absente ou vide (défaut)   | comme `on`                            | oui                              |
| `on`                       | tous, aux personnes qui ont consenti  | oui                              |
| `internal`                 | seulement aux administrateurs         | oui                              |
| `off`                      | aucun, ils restent en file (`queued`) | oui                              |
| toute autre valeur (faute) | comme `off` : le doute ferme l'envoi  | oui                              |

Rien n'est supprimé : en `off` ou `internal`, les emails écartés restent `queued`, ni envoyés ni annulés. Les
notifications dans l'application ne dépendent pas de l'interrupteur.

## Action immédiate

1. Dans Vercel, projet Immojudis, Settings, Environment Variables : poser `ALERT_NOTIFICATIONS_MODE=off` pour
   Production.
2. Redéployer la production (une variable d'environnement n'agit qu'au déploiement suivant).
3. Si un passage est en cours ou imminent (07:30 et 09:30 UTC, voir `vercel.json`), ne pas attendre : le
   redéploiement doit précéder ces heures.

## Vérifier

- `select started_at, status, summary from operational_job_runs where job_name = 'alert-notifications'
order by started_at desc limit 3;` : le résumé du passage suivant montre `emailMode: "off"`,
  `emailCandidateCount: 0` et `emailHeldBackCount` égal au nombre d'emails en file.
- `select delivery_status, count(*) from user_alert_notifications where delivery_channel = 'email'
and created_at > now() - interval '2 days' group by 1;` : plus de nouvelle ligne `sent`.

## Traiter la file

Les emails en file partiront tels quels le jour où le mode repasse à `on`. S'ils sont faux, les annuler d'abord
(écriture en production, à faire avec soin, en lisant d'abord le nombre de lignes) :

```sql
-- 1. Ce qui est en file
select count(*), min(scheduled_for), max(scheduled_for)
from user_alert_notifications
where delivery_channel = 'email' and delivery_status = 'queued';

-- 2. Annuler (resserrer le where si seule une partie est en cause : alert_id, user_id, scheduled_for)
update user_alert_notifications
set delivery_status = 'cancelled', updated_at = now()
where delivery_channel = 'email' and delivery_status = 'queued';
```

Si les emails sont corrects mais arrivent en retard après une longue coupure, laisser partir la file : le
récapitulatif regroupe les ventes par personne, un seul email par passage et par compte.

## Reprise

1. Corriger la cause (règle d'alerte, contenu, consentement).
2. Passer à `internal` pour un passage : seuls les administrateurs reçoivent l'email, à relire.
3. Passer à `on` (ou supprimer la variable, ce qui revient à `on`), puis redéployer.

## À savoir

- L'alerte d'exploitation `alerts.delivery.late` s'ouvre quand une notification reste `queued` plus de 26 h
  après son échéance : elle peut s'ouvrir pendant une coupure volontaire. Ce n'est pas une panne ; elle se ferme
  quand la file est vidée ou annulée (voir `alerts-delivery-late.md`).
- Une personne qui se désabonne (lien de l'email, ou email signalé en rebond ou plainte) voit ses emails en file
  annulés automatiquement.
- Aucun email n'est jamais envoyé depuis ce document : l'interrupteur ne fait que fermer.
