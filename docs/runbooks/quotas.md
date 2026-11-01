# Quotas des fournisseurs : relevé hebdomadaire et comportement dégradé

Objet : savoir où l'on en est avant qu'un plafond ne coupe un service, et ce qui se passe quand il est atteint.
Public : le propriétaire. Aucun agent ne se connecte aux tableaux de bord des fournisseurs : le relevé est fait
à la main.

Dernière relecture : 31/10/2026.

> **Les chiffres de plafond ci-dessous sont ceux des offres gratuites ou d'entrée, donnés à titre indicatif et
> susceptibles d'avoir changé.** Le plan réellement souscrit n'est pas écrit dans le dépôt (la documentation
> mentionne le plan Vercel Hobby : `docs/vercel_setup.md`, `docs/operations/planification.md`). Avant le premier
> relevé, noter dans le tableau le plafond **lu sur la page de facturation de chaque fournisseur**.

## Où lire la consommation

| Fournisseur | Ce qui consomme                                                                                            | Où le lire                                                                     | Plafond indicatif de l'offre d'entrée                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Mapbox      | Chargements de la carte interactive de `/sales`, images statiques des mini-cartes, géocodage d'adresses    | Compte Mapbox, statistiques d'utilisation                                      | Environ 50 000 chargements de carte, 50 000 images statiques et 100 000 requêtes de géocodage par mois sans frais       |
| Resend      | E-mails envoyés (alertes, rappels, récapitulatifs, contact, avocats, incidents, agent d'information)       | Resend, e-mails et utilisation ; limite de requêtes de l'API                   | Environ 3 000 e-mails par mois et 100 par jour sur l'offre gratuite ; un palier payant lève la limite quotidienne       |
| Supabase    | Taille de la base, stockage des photos (`sale-photos`), trafic sortant, comptes actifs, connexions         | Supabase, réglages, utilisation ; en SQL, la taille de la base (voir plus bas) | Offre gratuite : environ 500 Mo de base, 1 Go de fichiers, 5 Go de trafic sortant ; le palier payant en offre davantage |
| Vercel      | Transfert de données, requêtes en périphérie, exécutions de fonctions, régénérations de pages (ISR), crons | Vercel, projet, utilisation                                                    | Plan Hobby : quotas mensuels fixes et crons limités à un passage par jour (`docs/vercel_setup.md`)                      |

## Relevé hebdomadaire

Chaque lundi (une dizaine de minutes), reporter les chiffres dans un tableau tenu hors du dépôt (ou dans le
compte-rendu de la semaine), une ligne par fournisseur :

| Date | Fournisseur | Mesure | Consommé | Plafond du plan | Part du plafond | Extrapolation fin de mois | Décision |
| ---- | ----------- | ------ | -------- | --------------- | --------------- | ------------------------- | -------- |

L'**extrapolation** compte pour plus que le chiffre du jour : consommation du mois à ce jour, rapportée au
nombre de jours écoulés, multipliée par les jours du mois.

Seuils d'action, pour chaque mesure :

| Part du plafond (consommée ou extrapolée) | Décision                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Moins de 70 %                             | Rien, noter la valeur                                                                              |
| 70 % à 85 %                               | Surveiller : relever deux fois par semaine, chercher ce qui augmente                               |
| 85 % à 100 %                              | Agir cette semaine : réduire la consommation (leviers ci-dessous) ou changer de plan               |
| 100 % ou plus                             | Le service peut être dégradé ou facturé en supplément : suivre « Comportement attendu » ci-dessous |

Mesure de la base en lecture seule (éditeur SQL de Supabase) :

```sql
select pg_size_pretty(pg_database_size(current_database())) as base;

select n.nspname as schema, c.relname as table,
       pg_size_pretty(pg_total_relation_size(c.oid)) as taille
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname in ('public', 'app_private')
order by pg_total_relation_size(c.oid) desc
limit 10;
```

## Comportement dégradé attendu

### Mapbox

- **Carte interactive de `/sales`** : si le chargement de la carte échoue (quota, jeton révoqué, facturation
  suspendue), la carte affiche un message d'erreur ; la liste et les filtres restent utilisables. La carte ne
  démarre qu'au premier geste de l'utilisateur ou après un survol prolongé, ce qui limite les chargements.
- **Mini-cartes statiques** : l'image attendue ne s'affiche pas (comportement attendu, non testé) ; le texte de la fiche reste.
- **Recherche « autour d'une adresse »** : le géocodage bascule sur l'API adresse française (`src/lib/geo.ts`).
- Mapbox facture en général le dépassement plutôt que de couper : le risque est une **facture**, pas seulement
  une panne. Restreindre le jeton public aux adresses du site (compte Mapbox) et poser une alerte de dépense.
- Leviers : garder le chargement de la carte à la demande, éviter les rechargements inutiles du style, ne pas
  multiplier les mini-cartes sur les listes.

### Resend

- **Alertes, rappels, récapitulatifs** : les envois en échec laissent les notifications en file (`queued`) ;
  l'alerte `alerts.delivery.late` s'ouvre au-delà de 26 heures de retard et `alert-notifications` échoue quand
  20 % des e-mails dus échouent. Voir `docs/runbooks/alerts-delivery-late.md`. Ne pas passer les lignes à `sent`
  à la main.
- **Formulaire de contact** et courriels aux avocats : en erreur tant que l'envoi ne marche pas ; le formulaire
  affiche qu'il est indisponible quand la clé manque.
- **Incidents** : le canal e-mail des alertes opérationnelles échoue aussi (le canal principal, webhook ou
  GitHub, reste distinct).
- Leviers : passer `WEEKLY_DIGEST_MODE`, `SALE_RESULTS_MODE` puis `SALE_REMINDERS_MODE` à `off` ou `internal`
  (redéploiement nécessaire) ; baisser `ALERT_NOTIFICATION_CRON_LIMIT` pour étaler les envois ; passer à un
  palier payant avant l'ouverture des rappels à tous. Le volume futur se calcule : comptes avec alerte x
  envois par semaine. Les alertes n'ont pas d'interrupteur de coupure propre à ce jour.

### Supabase

- **Base pleine** : Supabase met la base en lecture seule quand le disque est plein. Les pages restent lisibles
  (si le cache et la lecture fonctionnent), mais la collecte, les inscriptions, les favoris et les alertes
  échouent. À traiter dans la journée : supprimer ce qui peut l'être (voir les rétentions de
  `docs/data-retention-matrix.md` et `public.run_data_retention`), puis augmenter le disque ou changer de
  plan. Ne pas supprimer des lignes à la main sans comptage préalable (`supabase/repairs/`).
- **Stockage des photos** (`sale-photos`) : plein, les nouvelles copies hébergées échouent. Voir
  `docs/runbooks/retrait-photos.md` pour ce qui concerne les photos.
- **Trafic sortant** : un dépassement ralentit ou restreint le projet selon le plan ; chercher d'abord la route ou
  l'export qui télécharge trop (journaux Vercel, `src/app/api`).
- **Connexions** : trop de connexions directes simultanées (collecte, migrations, fonctions serveur) font
  refuser les suivantes ; l'outil de dérive réessaie sur une erreur de connexion transitoire
  (`docs/vercel_setup.md`).
- **Projet en pause** (offre gratuite après une longue inactivité) : toutes les routes échouent ; non
  applicable à un projet actif.

### Vercel

- **Dépassement du plan Hobby** : Vercel prévient, puis peut suspendre le déploiement ou le projet jusqu'à la fin
  de la période. Le plan Hobby est en outre réservé à un usage non commercial : à vérifier pour un produit payant
  (`docs/operations/planification.md`).
- **Crons** : le plan Hobby n'autorise qu'un passage par jour ; les tâches fréquentes sont portées par
  Supabase `pg_cron` (`docs/vercel_setup.md`). Un cron manqué se voit dans `cron.stale`.
- **Régénérations de pages (ISR)** et requêtes en périphérie : un trafic ou un nombre de pages qui grossit
  les consomme ; les pages produites à la demande (`revalidate = 3600`) coûtent une régénération par heure et par
  page consultée.
- Leviers : allonger les durées de revalidation des pages peu consultées, vérifier l'absence de robots abusifs
  (journaux), passer à un plan payant avant la commercialisation.

## Quand un plafond est atteint

1. Identifier le service et l'effet (ci-dessus) ; si des utilisateurs sont touchés, prévenir (bandeau ou
   courrier selon la gravité).
2. Appliquer le levier le moins risqué (interrupteur ou limite), pas un changement de code urgent.
3. Décider du plan : montée de palier (effet immédiat dans la plupart des cas) ou réduction durable.
4. Noter l'incident et la décision dans le relevé ; ajouter une alerte du fournisseur (courrier à 80 % si le
   fournisseur le propose).

## Voir aussi

- `docs/runbooks/alerts-delivery-late.md` (e-mails en retard), `docs/runbooks/retour-arriere.md` (interrupteurs),
  `docs/runbooks/fuite-secret-ou-donnees.md` (jetons à restreindre ou régénérer).
- `docs/operations/planification.md` (cadence des tâches planifiées) et `docs/operations/supervision-externe.md`.
