import localFont from "next/font/local";

// Italique de Cormorant Garamond, NON préchargée : déclarée dans le layout racine, elle est
// disponible sur toutes les pages (accents de titre, `<em>`) mais ne pèse sur le premier écran
// d'aucune. Les pages qui l'affichent au-dessus de la ligne de flottaison (accueil, /ressources) la
// préchargent par `cormorant-garamond-italic-preloaded.ts`.
//
// Le nom de la constante compte : `next/font` en tire le nom de la famille (`cormorantGaramond`),
// le même que celui des graisses normales déclarées dans `src/app/layout.tsx`. Normal et italique
// forment ainsi UNE famille pour le navigateur (sinon `font-style: italic` tomberait sur une
// italique synthétique de la graisse normale). Ne pas la renommer ; un test le vérifie.
export const cormorantGaramond = localFont({
  src: [
    { path: "./cormorant-garamond-latin-italic.woff2", weight: "400", style: "italic" },
    { path: "./cormorant-garamond-latin-italic.woff2", weight: "500", style: "italic" },
    { path: "./cormorant-garamond-latin-italic.woff2", weight: "600", style: "italic" },
  ],
  display: "swap",
  variable: "--font-cormorant-garamond-italic",
  preload: false,
  // La police de secours ajustée est déjà déclarée par les graisses normales.
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});
