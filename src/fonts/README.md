# Police auto-hébergée

Chargée par `src/app/layout.tsx` avec `next/font/local` : le build ne dépend pas du réseau (aucun
téléchargement depuis Google Fonts). Next.js copie le fichier sous `/_next/static/media/` avec un
nom à empreinte et un cache `immutable`.

| Fichier               | Famille       | Axe          | Style  |
| --------------------- | ------------- | ------------ | ------ |
| `manrope-latin.woff2` | Manrope (v15) | wght 200-800 | normal |

Manrope est la seule police du site depuis le 25/10/2026 (à la place de Cormorant Garamond et d'IBM
Plex Sans), sans italique. Le layout la déclare en graisses 400 à 800, toutes sur ce même fichier
variable (un seul téléchargement), préchargée sur toutes les pages. `npm run build:budgets` vérifie
sur le build qu'un seul fichier de police est servi.

C'est le fichier WOFF2 de sous-ensemble `latin` (variable) de Google Fonts, récupéré le 25/10/2026
dans le paquet npm `@fontsource-variable/manrope` 5.2.5 (`files/manrope-latin-wght-normal.woff2`).
La licence SIL Open Font License 1.1 est conservée à côté : `OFL-manrope.txt` (copiée du même
paquet).

Pour mettre à jour la police : remplacer le fichier par la nouvelle version `latin` variable, sans
changer son nom, puis relancer `npm run build` et comparer le rendu.
