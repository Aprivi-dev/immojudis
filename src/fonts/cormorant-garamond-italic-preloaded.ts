import localFont from "next/font/local";

// Même italique que `cormorant-garamond-italic.ts`, mais PRÉCHARGÉE : `next/font` ne précharge une
// police que sur les routes dont un module l'appelle. Ce module n'est importé que par les pages qui
// affichent l'italique au premier écran (l'accueil et /ressources : accent « clarté. » / « Éclairer
// vos décisions. » du h1) ; les autres pages, /sales en tête, ne la préchargent plus.
//
// Même nom de constante, donc même famille `cormorantGaramond` : ses déclarations @font-face
// reprennent celles du layout (même graisse, même style) et, déclarées plus tard dans la cascade,
// les remplacent sur ces pages : le navigateur télécharge le fichier préchargé et lui seul.
export const cormorantGaramond = localFont({
  src: [
    { path: "./cormorant-garamond-latin-italic.woff2", weight: "400", style: "italic" },
    { path: "./cormorant-garamond-latin-italic.woff2", weight: "500", style: "italic" },
    { path: "./cormorant-garamond-latin-italic.woff2", weight: "600", style: "italic" },
  ],
  display: "swap",
  variable: "--font-cormorant-garamond-italic-preloaded",
  preload: true,
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});
