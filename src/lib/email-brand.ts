/**
 * Palette des emails : les jetons de la marque (`src/styles.css`, bloc « Immojudis core » et neutres).
 * Un email ne peut pas lire les variables CSS du site : les valeurs sont copiées ici, une fois, et
 * `email-brand.test.ts` les compare à la feuille de style pour qu'elles ne divergent pas. Avant, chaque
 * gabarit portait ses propres hexadécimaux (#182033, #7a5f1f, #6c7280…), hors de la palette, dont un
 * or à 3,9:1 sur blanc.
 *
 * Les textes dorés prennent `goldText` (5,7:1 sur blanc) ; `gold` sert aux filets et aux fonds, jamais
 * à un texte.
 */
export const EMAIL_COLORS = {
  /** `--brand-navy` : titres, boutons, texte principal. */
  navy: "#132238",
  /** `--gold` : filet de couleur, fond d'accent. */
  gold: "#c98d45",
  /** `--gold-text` : texte doré lisible. */
  goldText: "#84602e",
  /** `--ink-strong` : texte courant. */
  inkStrong: "#3d4b57",
  /** `--ink-soft` : texte secondaire, pied de message. */
  inkSoft: "#526170",
  /** `--line-warm` : filets des cartes et séparateurs. */
  lineWarm: "#e1d8ca",
  /** `--surface` : fond de la page de l'email. */
  surface: "#fffaf2",
  /** `--surface-muted` : panneau discret. */
  surfaceMuted: "#f8f5ef",
  /** `--cream` : pastille ou encadré doré clair. */
  cream: "#fff7eb",
  white: "#ffffff",
} as const;

/** Variable CSS du site dont chaque couleur est la copie (vérifié par le test). */
export const EMAIL_COLOR_TOKENS: Record<Exclude<keyof typeof EMAIL_COLORS, "white">, string> = {
  navy: "--brand-navy",
  gold: "--gold",
  goldText: "--gold-text",
  inkStrong: "--ink-strong",
  inkSoft: "--ink-soft",
  lineWarm: "--line-warm",
  surface: "--surface",
  surfaceMuted: "--surface-muted",
  cream: "--cream",
};

/** Nom de marque dans les emails : « Immojudis », jamais en capitales (voir la charte). */
export const EMAIL_BRAND_NAME = "Immojudis";
