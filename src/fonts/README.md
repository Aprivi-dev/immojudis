# Polices auto-hébergées

Chargées par `src/app/layout.tsx` avec `next/font/local` : le build ne dépend plus du réseau
(plus de téléchargement depuis Google Fonts). Next.js les copie sous `/_next/static/media/` avec
un nom à empreinte et un cache `immutable`.

| Fichier                                 | Famille                  | Axe          | Style  |
| --------------------------------------- | ------------------------ | ------------ | ------ |
| `cormorant-garamond-latin-normal.woff2` | Cormorant Garamond (v21) | wght 300-700 | normal |
| `cormorant-garamond-latin-italic.woff2` | Cormorant Garamond (v21) | wght 300-700 | italic |
| `ibm-plex-sans-latin.woff2`             | IBM Plex Sans (v23)      | wght 100-700 | normal |

Cormorant Garamond forme une seule famille CSS (`cormorantGaramond`, nom tiré de la constante du layout) :
les graisses normales, préchargées, par `next/font` dans `src/app/layout.tsx` ; l'italique par trois
`@font-face` de `src/styles.css` (un seul fichier, jamais préchargé par le layout). L'accueil et `/ressources`,
seules pages qui l'affichent au premier écran, le préchargent par `src/components/PreloadCormorantItalic.tsx`
(`preload` de `react-dom`, avec l'URL du fichier importée, la même que celle du `@font-face`). Pas
`next/font` pour l'italique : il précharge tout fichier déclaré sur toutes les routes qui l'appellent, et
deux déclarations du même fichier (une préchargée, une non) en produisent deux copies. Le composant est
client exprès : un `preload` serveur partirait dans les charges RSC préfetchées par le menu de `/sales`, qui
ajouterait alors l'italique à son `<head>`. `npm run build:budgets` vérifie tout cela sur le build.

Ce sont les fichiers WOFF2 de sous-ensemble `latin` (variables) que servait `next/font/google`,
récupérés le 16/10/2026 sur `fonts.gstatic.com` via l'API CSS de Google Fonts
(`https://fonts.googleapis.com/css2?family=…`). Les licences SIL Open Font License 1.1 sont
conservées à côté : `OFL-cormorant-garamond.txt` et `OFL-ibm-plex-sans.txt` (copiées du dépôt
`google/fonts`, dossiers `ofl/cormorantgaramond` et `ofl/ibmplexsans`).

Pour mettre à jour une police : télécharger le nouveau fichier `latin` depuis la même API, le
remplacer ici sans changer le nom, puis relancer `npm run build` et comparer le rendu.
