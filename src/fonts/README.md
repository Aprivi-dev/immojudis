# Polices auto-hébergées

Chargées par `src/app/layout.tsx` avec `next/font/local` : le build ne dépend plus du réseau
(plus de téléchargement depuis Google Fonts). Next.js les copie sous `/_next/static/media/` avec
un nom à empreinte et un cache `immutable`.

| Fichier                                 | Famille                  | Axe          | Style  |
| --------------------------------------- | ------------------------ | ------------ | ------ |
| `cormorant-garamond-latin-normal.woff2` | Cormorant Garamond (v21) | wght 300-700 | normal |
| `cormorant-garamond-latin-italic.woff2` | Cormorant Garamond (v21) | wght 300-700 | italic |
| `ibm-plex-sans-latin.woff2`             | IBM Plex Sans (v23)      | wght 100-700 | normal |

Ce sont les fichiers WOFF2 de sous-ensemble `latin` (variables) que servait `next/font/google`,
récupérés le 16/10/2026 sur `fonts.gstatic.com` via l'API CSS de Google Fonts
(`https://fonts.googleapis.com/css2?family=…`). Les licences SIL Open Font License 1.1 sont
conservées à côté : `OFL-cormorant-garamond.txt` et `OFL-ibm-plex-sans.txt` (copiées du dépôt
`google/fonts`, dossiers `ofl/cormorantgaramond` et `ofl/ibmplexsans`).

Pour mettre à jour une police : télécharger le nouveau fichier `latin` depuis la même API, le
remplacer ici sans changer le nom, puis relancer `npm run build` et comparer le rendu.
