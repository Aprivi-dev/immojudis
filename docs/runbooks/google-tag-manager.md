# Google Tag Manager, Google Analytics 4 et Search Console

Le site charge le conteneur Google Tag Manager `GTM-M2MWWPJQ`, qui porte la balise Google Analytics 4
(flux `G-FVY2EYX5MP`). Comme avant, **rien n'est chargé sans l'accord du visiteur** (bandeau ou
politique de confidentialité) : sans accord, ni `gtm.js` ni `gtag/js` ne sont demandés et aucun cookie
n'est déposé (`src/lib/google-analytics.ts`, `src/components/GoogleAnalytics.tsx`).

## Qui fait quoi

| Où                       | Quoi                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code (dépôt)             | Charge `gtm.js` après accord ; pose le Consent Mode (stockage publicitaire refusé, stockage de mesure accordé) ; publie une page vue `immojudis_page_view` à chaque changement de chemin, avec l'adresse nettoyée ; coupe tout au retrait de l'accord. |
| Conteneur GTM            | Déclenche la balise Google `G-FVY2EYX5MP` et l'événement GA4 `page_view` **sur `immojudis_page_view` seulement**, avec les réglages de confidentialité ci-dessous.                                                                                     |
| Console Google Analytics | Conservation, signaux Google, mesure améliorée : `docs/runbooks/reglages-google-analytics.md`.                                                                                                                                                         |
| Search Console           | Propriété Domaine vérifiée par DNS ; liaison avec Google Analytics (section dédiée).                                                                                                                                                                   |

Ce que le code publie dans `dataLayer`, à chaque page :

```js
{ event: "immojudis_page_view", page_location: "https://immojudis.com/sales?utm_source=…", page_referrer: "…", page_title: "…" }
```

`page_location` ne contient ni jeton de partage, ni code de connexion, ni paramètre de recherche (seuls les
`utm_*` sans arobase restent). Les pages `/admin`, `/compte`, `/contribuer`, `/login` et `/mes-droits` ne
publient rien.

## Configuration du conteneur

Deux façons équivalentes. Dans les deux cas, terminer par « Vérifier » puis « Publier ».

### A. Import (le plus rapide)

GTM → Administration → **Importer un conteneur** → fichier `docs/runbooks/google-tag-manager-conteneur.json`
→ espace de travail par défaut → **Fusionner** → **Renommer les éléments en conflit**. Relire ensuite
chaque élément avec la liste B : l'import doit donner exactement cela.

### B. À la main

**Variables** (Variables → Variables définies par l'utilisateur → Nouvelle → _Variable de couche de
données_, version 2) :

- `DLV - page_location` : nom `page_location`
- `DLV - page_referrer` : nom `page_referrer`
- `DLV - page_title` : nom `page_title`

**Déclencheur** : `CE - immojudis_page_view`, type _Événement personnalisé_, nom de l'événement
`immojudis_page_view`, « Tous les événements personnalisés ».

**Balise 1 : `Google tag - GA4 G-FVY2EYX5MP`**, type _Balise Google_, ID de balise `G-FVY2EYX5MP`,
déclencheur `CE - immojudis_page_view` (**pas** « Initialisation - Toutes les pages » : la balise
partirait avec l'adresse complète du navigateur). Paramètres de configuration :

| Paramètre                          | Valeur                    | Pourquoi                                                    |
| ---------------------------------- | ------------------------- | ----------------------------------------------------------- |
| `send_page_view`                   | `false`                   | La page vue part par la balise 2, une seule fois            |
| `page_location`                    | `{{DLV - page_location}}` | Adresse nettoyée, reprise aussi par les événements suivants |
| `page_referrer`                    | `{{DLV - page_referrer}}` | Provenance nettoyée                                         |
| `page_title`                       | `{{DLV - page_title}}`    |                                                             |
| `cookie_expires`                   | `33696000`                | 13 mois (plafond CNIL) au lieu de 2 ans                     |
| `cookie_update`                    | `false`                   | Pas de prolongation à chaque visite                         |
| `allow_google_signals`             | `false`                   | Pas de recoupement avec les comptes Google                  |
| `allow_ad_personalization_signals` | `false`                   | Pas de personnalisation publicitaire                        |

Paramètres avancés → Priorité de déclenchement : `10` (elle passe avant la balise 2).

**Balise 2 : `GA4 - page_view`**, type _Google Analytics : événement GA4_, ID de mesure `G-FVY2EYX5MP`, nom
d'événement `page_view`, paramètres `page_location`, `page_referrer`, `page_title` (mêmes variables),
déclencheur `CE - immojudis_page_view`.

**Paramètres de consentement** : laisser « Non défini » sur les deux balises ; les balises Google lisent
d'elles-mêmes le Consent Mode posé par le code.

### Ce qu'il ne faut pas faire dans GTM

- Ne pas ajouter de déclencheur « Toutes les pages », « Initialisation » ou « Modification de l'historique »
  aux balises Google : elles enverraient l'adresse brute (jetons, recherches) ou compteraient chaque page
  deux fois.
- Ne pas créer de variable « JavaScript personnalisé » ni de « Variable JavaScript » lisant l'adresse
  (`{{Page URL}}`, `{{Page Path}}`) dans une balise : la première est bloquée en production par la CSP
  (`'unsafe-eval'` refusé), la seconde contourne le nettoyage des adresses.
- Ne pas ajouter de balise publicitaire (Google Ads, Meta, etc.) : la politique de confidentialité et le
  bandeau annoncent une mesure d'audience sans publicité. Toute nouvelle balise demande une revue (finalité,
  texte du bandeau, sources `connect-src` de `src/lib/security-headers.ts`), puisqu'une publication GTM ne
  passe pas par la relecture du code.
- Garder la liste des utilisateurs du conteneur (Administration → Gestion des utilisateurs) réduite aux
  personnes habilitées : publier dans GTM revient à mettre du code en production.

## Search Console

- **Vérification : déjà faite par DNS, rien à changer.** `immojudis.com` porte l'enregistrement TXT
  `google-site-verification=…` (propriété _Domaine_, voir `docs/vercel_setup.md`, étape 5). Elle couvre
  `www`, `http` et les sous-domaines et ne dépend d'aucun script.
- **Ne pas utiliser la méthode de vérification « Google Tag Manager »** : le conteneur n'est chargé
  qu'après l'accord du visiteur, et le robot de Google ne donne jamais cet accord ; la vérification
  échouerait ou sauterait plus tard.
- **Liaison avec Google Analytics** (à faire une fois, dans la console, pas dans GTM) : Google Analytics →
  Administration → Liens vers les produits → **Associations à Search Console** → Associer → choisir la
  propriété `immojudis.com` → flux Web `G-FVY2EYX5MP` → Envoyer. Il faut être propriétaire vérifié dans
  Search Console et éditeur dans Google Analytics. Les rapports « Search Console » apparaissent ensuite
  dans Google Analytics (Rapports → Bibliothèque → publier la collection « Search Console »).

## Vérifier

1. GTM → **Prévisualiser** → `https://immojudis.com`. Dans l'onglet ouvert, **accepter le bandeau** : sans
   accord, le conteneur n'est pas chargé et Tag Assistant ne se connecte pas (c'est voulu).
2. Dans Tag Assistant, chaque page doit montrer un événement `immojudis_page_view` avec les deux balises
   déclenchées. Aucune balise ne doit partir sur `Container Loaded`, `DOM Ready` ou `Window Loaded`.
3. Ouvrir une adresse avec un paramètre de recherche (`/sales?departement=75&utm_source=test`) : la
   variable `DLV - page_location` doit valoir `…/sales?utm_source=test`.
4. Google Analytics → Rapports → Temps réel : la visite apparaît avec l'adresse nettoyée.
5. Fenêtre privée sans accepter le bandeau : l'onglet Réseau ne montre aucune requête vers
   `googletagmanager.com` ni `google-analytics.com`, et aucun cookie `_ga` n'existe.

Les tests du dépôt couvrent le comportement du code (`src/lib/google-analytics.test.ts`,
`src/components/GoogleAnalytics.test.tsx`) ; le contenu du conteneur, lui, ne se vérifie que dans GTM.

## Consigner

Noter dans un compte-rendu daté (`docs/equipe/`) la version GTM publiée, la date, la personne et le
résultat des contrôles ci-dessus.
