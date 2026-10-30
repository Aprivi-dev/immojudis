# Google Tag Manager, Google Analytics 4 et Search Console

Le site charge le conteneur Google Tag Manager `GTM-M2MWWPJQ`, auquel le flux Google Analytics 4
`G-FVY2EYX5MP` est relié comme destination. Comme avant, **rien n'est chargé sans l'accord du visiteur**
(bandeau ou politique de confidentialité) : sans accord, `gtm.js` n'est pas demandé et aucun cookie n'est
déposé (`src/lib/google-analytics.ts`, `src/components/GoogleAnalytics.tsx`).

## Qui fait quoi

| Où                       | Quoi                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code (dépôt)             | Charge `gtm.js` après accord ; pose le Consent Mode et **tous les réglages GA4** par `gtag('set')` avant `gtag('js')` ; envoie chaque page vue (`gtag('event', 'page_view')`) avec l'adresse nettoyée ; coupe tout au retrait. |
| Conteneur GTM            | Relie la destination GA4 `G-FVY2EYX5MP`. **Aucune balise Google Analytics à ajouter** (voir plus bas).                                                                                                                         |
| Console Google Analytics | Conservation, signaux Google, mesure améliorée, collecte des données fournies : `docs/runbooks/reglages-google-analytics.md`.                                                                                                  |
| Search Console           | Propriété Domaine vérifiée par DNS ; liaison avec Google Analytics (section dédiée).                                                                                                                                           |

Réglages posés par le code, avant le démarrage du conteneur : `send_page_view: false`, `page_location`
nettoyée, `cookie_expires` de 13 mois, `cookie_update: false`, `allow_google_signals: false`,
`allow_ad_personalization_signals: false` ; Consent Mode : `ad_storage`, `ad_user_data` et
`ad_personalization` refusés, `analytics_storage` accordé.

### Pourquoi `set` avant `js`, et pas `config`

Le conteneur configure la destination GA4 dès son démarrage (`gtag('js')`). Contrôlé le 30/10/2026 contre
le conteneur publié : sans réglage préalable, il envoie aussitôt une page vue avec l'adresse brute du
navigateur (paramètres de recherche, jetons) et des cookies de 400 jours ; un `gtag('config', …)`, même
envoyé juste après `js`, ne l'empêche pas. Les mêmes réglages posés par `gtag('set', …)` **avant** `js`
suppriment cette page vue et ramènent les cookies à 13 mois.

## Ce qu'il ne faut pas faire dans GTM

- **N'ajouter aucune balise « Balise Google » ni « Événement GA4 » pour `G-FVY2EYX5MP`** : le site envoie
  déjà les pages vues ; une balise de plus les doublerait, et une balise sur « Toutes les pages » ou
  « Initialisation » les enverrait avec l'adresse brute.
- Ne pas créer de variable « JavaScript personnalisé » (bloquée en production par la CSP, `'unsafe-eval'`
  refusé) ni de variable qui lit l'adresse (`{{Page URL}}`, `{{Page Path}}`) dans une balise : elle
  contournerait le nettoyage des adresses.
- Ne pas ajouter de balise publicitaire (Google Ads, Meta, etc.) : la politique de confidentialité et le
  bandeau annoncent une mesure d'audience sans publicité. Toute nouvelle balise demande une revue (finalité,
  texte du bandeau, sources `connect-src` de `src/lib/security-headers.ts`), puisqu'une publication GTM ne
  passe pas par la relecture du code.
- Garder la liste des utilisateurs du conteneur (Administration → Gestion des utilisateurs) réduite aux
  personnes habilitées : publier dans GTM revient à mettre du code en production.

## Le diagnostic GTM « Taux de consentement de 0 % »

GTM signale un taux de consentement de 0 % parce que les trois signaux **publicitaires** (`ad_storage`,
`ad_user_data`, `ad_personalization`) sont toujours refusés : c'est voulu, le site n'a aucune publicité ni
remarketing. Le signal de **mesure** (`analytics_storage`) est accordé pour chaque visiteur qui accepte
(paramètre `gcs=G101` des requêtes Google Analytics) : la mesure d'audience n'est pas affectée. Ce
diagnostic vise les annonceurs ; il n'y a rien à corriger.

## Search Console

- **Vérification : déjà faite par DNS, rien à changer.** `immojudis.com` porte l'enregistrement TXT
  `google-site-verification=…` (propriété _Domaine_, voir `docs/vercel_setup.md`, étape 5). Elle couvre
  `www`, `http` et les sous-domaines et ne dépend d'aucun script.
- **Ne pas utiliser la méthode de vérification « Google Tag Manager »** : le conteneur n'est chargé
  qu'après l'accord du visiteur, et le robot de Google ne donne jamais cet accord.
- **Liaison avec Google Analytics** (une fois, dans la console) : Google Analytics → Administration →
  Liens vers les produits → **Associations à Search Console** → Associer → propriété `immojudis.com` → flux
  Web `G-FVY2EYX5MP` → Envoyer. Il faut être propriétaire vérifié dans Search Console et éditeur dans
  Google Analytics.

## Vérifier

1. Fenêtre privée, `https://immojudis.com/sales?departement=75&utm_source=test` : tant que le bandeau n'a
   pas été accepté, l'onglet Réseau ne montre aucune requête vers `googletagmanager.com` ni
   `google-analytics.com`, et aucun cookie `_ga` n'existe.
2. Accepter : une requête `g/collect` part avec `en=page_view` et `dl=…/sales?utm_source=test` (sans
   `departement`). Aucune autre page vue ne doit porter l'adresse complète.
3. Les cookies `_ga` et `_ga_FVY2EYX5MP` expirent dans environ 13 mois (pas 2 ans ni 400 jours).
4. Google Analytics → Rapports → Temps réel : la visite apparaît.

Les tests du dépôt couvrent le comportement du code (`src/lib/google-analytics.test.ts`,
`src/components/GoogleAnalytics.test.tsx`, `e2e/consent.spec.ts`) ; le contenu du conteneur, lui, ne se
vérifie que dans GTM.

## Consigner

Noter dans un compte-rendu daté (`docs/equipe/`) la version GTM publiée, la date, la personne et le
résultat des contrôles ci-dessus.
