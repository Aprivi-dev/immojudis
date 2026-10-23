# Réglages Google Analytics 4 à vérifier dans la console

Le site charge Google Analytics 4 (flux `G-FVY2EYX5MP`) **seulement après l'accord du visiteur** (bandeau de
consentement ou politique de confidentialité). Sans accord, aucun script Google n'est chargé et aucun cookie
n'est déposé ; au retrait de l'accord, les envois cessent et les cookies `_ga*` sont effacés
(`src/lib/google-analytics.ts`, `src/components/GoogleAnalytics.tsx`).

Une partie de la configuration vit **dans le code**, l'autre **dans la console Google Analytics**, que le
dépôt ne peut pas lire. Ce runbook liste ce que le propriétaire doit contrôler dans la console. **Il ne dit
pas que ces réglages sont faits** : cocher chaque ligne après l'avoir regardée à l'écran, puis consigner la
date et la personne (voir « Consigner »).

## Ce que le code fait déjà (aucune action)

- Pas de page vue automatique (`send_page_view: false`) : chaque page vue part avec une adresse nettoyée par
  `sanitizeAnalyticsUrl` (ni jeton de partage, ni code de connexion, ni paramètre de recherche ; seuls les
  paramètres de campagne `utm_*`, `gclid`, `gbraid`, `wbraid` restent).
- Consent Mode : stockage publicitaire refusé (`ad_storage`, `ad_user_data`, `ad_personalization` à
  `denied`), seul le stockage de mesure est accordé puisque la personne l'a accepté.
- `allow_google_signals: false` et `allow_ad_personalization_signals: false`.
- Cookies de 13 mois au plus, sans prolongation à chaque visite (`cookie_expires`, `cookie_update: false`).
- L'opposition à la mesure d'audience l'emporte sur l'accord.

Le code ne peut pas empêcher ce que la console réactive : d'où la liste suivante.

## À vérifier dans la console (Administration)

Cocher après contrôle. Les chemins de menu sont ceux de l'interface de Google Analytics 4 et peuvent changer
de libellé.

### 1. Conservation des données

- [ ] _Administration > Collecte et modification des données > Conservation des données_ : conservation des
      données d'événement réglée sur **14 mois** (le maximum de l'offre standard ; la valeur par défaut est de
      2 mois). Le chiffre retenu par la session du 23/10/2026 est 14 mois ; il s'aligne sur la durée des
      cookies (13 mois) et doit figurer dans la matrice de conservation (`docs/data-retention-matrix.md`).
- [ ] La réinitialisation des données utilisateur à chaque nouvelle activité : noter le choix fait. Il
      allonge la durée effective pour un visiteur régulier.

### 2. Recoupement des données

- [ ] _Collecte et modification des données > Signaux Google_ : **désactivés** (le code les refuse déjà ;
      la console doit être d'accord).
- [ ] _Identité de reporting_ : une identité qui ne recoupe pas les appareils (basée sur l'appareil), de sorte
      qu'aucun identifiant de compte Google ne soit rapproché des visites.
- [ ] _Collecte et modification des données > Collecte de données_ (ou équivalent) : aucune fonction de
      personnalisation publicitaire activée. Vérifier qu'aucun lien avec Google Ads (ou un autre produit
      publicitaire) n'existe, ou que, s'il existe, il est voulu et consigné.
- [ ] _Paramètres de partage de données_ : notez ce qui est partagé avec Google (produits et services Google,
      assistance technique, spécialistes de compte) ; désactiver ce qui n'a pas de raison d'être.

### 3. Mesure améliorée

_Administration > Flux de données > flux Web > Mesure améliorée_ (engrenage) :

- [ ] **Changements de page basés sur l'historique de navigation : désactivé.** Sinon chaque navigation
      compte deux pages vues, la seconde avec l'adresse complète (raison inscrite dans `google-analytics.ts`).
- [ ] **Téléchargements de fichiers : désactivé** (les liens des pièces peuvent porter un jeton d'accès).
- [ ] **Clics sortants : désactivé.**
- [ ] **Interactions avec les formulaires : désactivé.**
- [ ] **Recherche sur le site : désactivé** (les recherches du site vont dans l'adresse et le code ne les
      transmet pas).
- [ ] Défilement et engagement vidéo : noter le choix fait (ils n'envoient pas d'adresse complète).

Une case de la mesure améliorée réactivée par erreur contourne le nettoyage des adresses du code : c'est le
réglage le plus risqué de la liste.

### 4. Accès

- [ ] _Gestion des accès au compte et à la propriété_ : seules les personnes habilitées y figurent.
- [ ] Les exports et rapports ne sont pas partagés par un lien public.

## Consigner

Après contrôle, noter dans un compte-rendu daté (`docs/equipe/` ou le registre du propriétaire) : la date, la
personne, la valeur de chaque ligne ci-dessus (une capture d'écran de la conservation et de la mesure
améliorée suffit), et ce qui a été changé. Ne pas écrire « conforme » sans cette trace.

## Vérifier côté site

Rien à lancer en production. Les tests du dépôt couvrent l'absence de requête Google avant accord, le refus
sans requête, et le chargement après accord : `src/lib/google-analytics.test.ts`,
`src/components/GoogleAnalytics.test.tsx`, `src/lib/security-headers.test.ts`. Pour un contrôle manuel,
ouvrir le site dans une fenêtre privée : tant que le bandeau n'a pas été accepté, l'onglet Réseau ne montre
aucune requête vers `googletagmanager.com` ni `google-analytics.com`, et aucun cookie `_ga` n'existe.

## Si un réglage est faux

Corriger dans la console, consigner la date, et, si une donnée a été collectée avec un mauvais réglage
(par exemple une adresse complète avec jeton via la mesure améliorée), le signaler au propriétaire : la
suppression de données dans GA4 est une demande de suppression à la console, à traiter à part.
