# Arrêt d'urgence des pépites

Objet : retirer les pépites du public en moins de deux minutes. Public : le propriétaire (administrateur,
double authentification comprise).

À utiliser quand une pépite est manifestement fausse, après une plainte, une erreur de règle ou une source
erronée. Le calcul continue en coulisse (mode `shadow`) : rien n'est perdu, rien n'est visible.

Dernier essai : jamais (à dater après un essai en préproduction ou à blanc).

## Ce que fait le bouton

« Suspendre les pépites », sur `/admin/pepites`, appelle `POST /api/admin/pepites` puis la fonction
`public.suspend_sale_pepites` (migration `20261104100000_sale_pepites.sql`). Cette fonction ne sait faire
qu'une chose : passer le mode de `on` à `shadow` (ou `off`), jamais l'inverse. Elle est sans effet si le mode
n'est pas `on`. Le bouton n'apparaît que si le mode vaut `on`, et il envoie `shadow`.

| Mode     | Calcul des pépites | Visible du public |
| -------- | ------------------ | ----------------- |
| `on`     | oui                | oui               |
| `shadow` | oui                | non               |
| `off`    | non                | non               |

Effets après le clic :

- les fonctions publiques (`get_public_sale_pepite`, `list_public_pepite_sale_ids`) ne rendent plus rien ;
- les caches du site sont expirés tout de suite (`expirePepiteCaches` dans `src/lib/admin-pepites.ts`) ;
- le CDN garde la réponse des routes `/api/sales/<id>/pepite` et `/api/catalogue/pepites` jusqu'à 60 s
  (plus 30 s de revalidation) : compter environ 90 s avant que tout le monde ne voie le changement ;
- les alertes « seulement les pépites » ne trouvent plus rien.

## Avant : lire le mode

Dans l'éditeur SQL de Supabase (lecture seule) :

```sql
select mode, updated_at, updated_by from app_private.sale_pepite_settings;
```

## Action

1. Se connecter en administrateur, ouvrir `/admin/pepites`.
2. Cliquer sur **Suspendre les pépites** et confirmer la boîte de dialogue.
3. La page se recharge et affiche le nouveau mode.

## Vérifier

- Le même `select` donne `mode = shadow`, avec votre identifiant dans `updated_by`.
- `/admin/pepites` affiche le mode `shadow` et le bouton a disparu.
- Environ 90 s plus tard, une fiche qui était pépite n'affiche plus le bloc, et un `GET` public sur
  `/api/sales/<id>/pepite` répond 404.

## Si le bouton ne marche pas

- **Le bouton est absent** : le mode n'est déjà plus `on` (`shadow` ou `off`), ou la page l'indique `unknown`
  (migration absente). Relire le mode avec le `select` ci-dessus.
- **Erreur 403** : le compte n'est pas administrateur, ou la double authentification n'est pas faite.
- **L'interface est hors service** : le propriétaire peut appeler directement
  `select public.suspend_sale_pepites('shadow', null);` dans l'éditeur SQL. C'est une écriture en production,
  à réserver à l'urgence ; la fonction est sans danger, car elle ne sait que fermer.

## Retour arrière (rouvrir les pépites)

**Il n'existe aucun bouton de réouverture.** Il faut une migration dédiée, sur le modèle de
`supabase/migrations/20261105100000_sale_pepites_open.sql` (`update ... set mode = 'on' where mode = 'shadow'`),
relue puis appliquée par le workflow « Apply Supabase Migrations » (manuel, depuis `main`, avec confirmation).

Piège : une telle migration rouvre aussi une suspension d'urgence. Ne la fusionner qu'après avoir traité la
cause qui a motivé l'arrêt.

## Après l'arrêt

Consigner l'incident dans `docs/equipe/` (cause, heure, ventes concernées). Aucun email n'est obligatoire. Si
la cause est la règle elle-même, voir aussi `docs/runbooks/pepite-v2-ouverture.md`.
