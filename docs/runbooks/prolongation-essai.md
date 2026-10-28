# Prolonger l'essai gratuit de comptes choisis

Objet : donner à des comptes choisis l'accès à l'offre Analyse au-delà de leur essai de 7 jours (bêta-testeurs,
retour d'expérience promis, réouverture des paiements…). Public : le propriétaire, administrateur avec double
authentification. L'essai de 7 jours lui-même est décrit dans `docs/runbooks/offre-de-lancement.md`.

Dernier essai : jamais (à dater après un essai sur un compte de test).

## Où et comment

- Interface : **Admin > Inscriptions** (`/admin/inscriptions`, composant `AdminSignupsPanel`). Elle liste tous
  les comptes (administrateurs exclus), avec leur accès à cet instant : « Essai 7 jours », « Essai prolongé »,
  « Analyse (payant) », « Analyse (attribué) », « Accès complet », « Découverte ».
- Filtre « Type d'accès » et recherche par email ou par nom, 50 comptes par page.
- Cocher des comptes (la case de l'en-tête coche la page), choisir **Essai prolongé jusqu'au** (champ date et
  heure, ou les raccourcis « + 7 jours », « + 14 jours », « + 30 jours »), saisir au besoin une **note interne**,
  puis **Prolonger l'essai**.
- API : `GET` et `POST /api/admin/signups` (administrateur et double authentification, délai de 30 s).

## Limites

- La date de fin est **dans le futur** et au plus **366 jours** après maintenant.
- **100 comptes au plus** par envoi.
- Note : **500 caractères** au plus.
- Un compte refusé apparaît dans « Comptes non prolongés », avec sa raison : compte introuvable, administrateur,
  compte premium, abonnement Stripe en cours, accès Analyse déjà ouvert au-delà de cette date, accès déjà sans
  date de fin. Rejouer la même prolongation est donc sans effet (pas de doublon).
- Une prolongation **ne raccourcit jamais** un accès plus long.

## Effet (écrit en production)

Un `upsert` dans `public.user_subscriptions` : `plan_code = analyse`, `status = trialing`,
`current_period_end` = la date choisie, et `metadata.manual_grant` (`source = admin_trial_extension`, auteur,
note, date). Une prolongation suivante remplace `manual_grant` (il n'y a pas d'historique). L'accès se ferme
seul à la date : la fonction d'accès `has_active_analysis_access` exige un statut `trialing` ou `active` et une
fin dans le futur. Le compte revient alors en Découverte sans autre geste.

Interaction avec Stripe : un futur abonnement Stripe réécrit la ligne (webhook). Le checkout n'ajoute plus d'essai
(`STRIPE_CHECKOUT_TRIAL_OFFERED = false`). Point connu, en cours de traitement (propositions n° 11 et 12 du
compte-rendu du 27/10/2026) : tant que la prolongation s'enregistre comme un abonnement ordinaire, un compte
prolongé ne peut pas souscrire avant sa date de fin et voit des boutons Stripe qui échouent.

## Essai sans risque

Prolonger d'abord **un seul compte de test** (le sien) d'un jour, relire la ligne (ci-dessous), puis seulement
traiter les comptes réels.

## Contrôler

```sql
select user_id, plan_code, status, current_period_end,
       metadata->'manual_grant' as manual_grant
from public.user_subscriptions
where user_id = '<uuid>';
```

Attendu : `analyse`, `trialing`, la date choisie, `manual_grant.source = admin_trial_extension`. Dans
l'interface, la ligne du compte affiche « Essai prolongé » et « jusqu'au … ».

## Retour arrière

Il n'y a **pas de bouton « annuler »**, et reprolonger ne raccourcit pas (la demande est refusée : « déjà ouvert
au-delà »). Pour fermer plus tôt, par le propriétaire et ligne à ligne (écriture en production) :

```sql
update public.user_subscriptions
   set current_period_end = now()
 where user_id = '<uuid>' and metadata->'manual_grant'->>'source' = 'admin_trial_extension';
```

ou l'outil « Clients & abonnements » de l'administration.

## À l'ouverture des paiements : prolonger tous les essais terminés

Décision du propriétaire (27/10/2026, proposition n° 15) : le jour où Stripe ouvre, **prolonger tous les essais
terminés jusqu'à « ouverture + 7 jours »**, pour que personne n'ait perdu son essai avant de pouvoir payer.
Durée (7 ou 14 jours) : décision du fondateur après mesure.

À faire seulement après la correction de la proposition n° 11 (la prolongation doit se comporter comme un essai
et ne pas bloquer la souscription), et le jour même de l'ouverture :

1. Calculer la date : jour d'ouverture + 7 jours, par exemple fin de journée (23 h 59). Les raccourcis partent de
   « maintenant » : saisir la date à la main dans le champ.
2. Dans `/admin/inscriptions`, filtrer **Découverte**. Ne retenir que les lignes dont le détail dit « Essai
   terminé le … ». Écarter celles qui disent « Sans essai (adresse déjà utilisée ou jetable) » : leur donner
   l'accès serait contourner la règle « un essai par personne ». La case de l'en-tête coche aussi ces lignes :
   les décocher à la main.
3. Mettre en note « Prolongation d'ouverture des paiements, <date> », puis **Prolonger l'essai**. Le lot est
   limité à 100 comptes et la sélection tient sur plusieurs pages : recommencer par lots tant qu'il reste des
   essais terminés.
4. Contrôler le résultat : nombre de lignes prolongées (le `select` ci-dessous) et l'état d'un compte de test.

   ```sql
   select count(*) from public.user_subscriptions
   where metadata->'manual_grant'->>'source' = 'admin_trial_extension'
     and current_period_end = '<date ISO UTC>';
   ```

5. Les comptes en essai en cours ne sont pas concernés : leur essai continue jusqu'à sa date.
