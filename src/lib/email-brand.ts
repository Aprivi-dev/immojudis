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
  /** `--line` : bordure de la carte. */
  line: "#d8cfc1",
  /** `--line-warm` : filets internes et séparateurs. */
  lineWarm: "#e1d8ca",
  /** `--background` : fond de la page de l'email (le papier chaud du site). */
  background: "#fbf9f5",
  /**
   * `--background` encore, sous son nom de la charte : le « papier » des pages web sans feuille de
   * style (erreur globale), qui ne sont pas des emails.
   */
  paper: "#fbf9f5",
  /** `--surface` : fond des pages web de confirmation (désinscription, erreur), pas des emails. */
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
  line: "--line",
  lineWarm: "--line-warm",
  background: "--background",
  paper: "--background",
  surface: "--surface",
  surfaceMuted: "--surface-muted",
  cream: "--cream",
};

/** Nom de marque dans les emails : « Immojudis », jamais en capitales (voir la charte). */
export const EMAIL_BRAND_NAME = "Immojudis";

/**
 * Pile de polices des emails : Manrope (la police du site) quand le client de messagerie la possède,
 * sinon une sans empattement système. Manrope n'est pas chargée dans un email : c'est un repli, pas
 * une faute. Plus de Georgia : le serif était un vestige de l'ancienne marque. Apostrophes simples :
 * la pile se glisse dans des attributs `style="…"`.
 */
export const EMAIL_FONT_STACK = "Manrope, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Palette du mode sombre (`@media (prefers-color-scheme: dark)`). Elle n'existe pas sur le site, qui n'a
 * pas de thème sombre : ce sont les valeurs validées pour les emails, et seulement elles.
 */
export const EMAIL_DARK_COLORS = {
  /** Fond de la page. */
  page: "#07111f",
  /** Fond de la carte. */
  card: "#132238",
  /** Texte principal et titres. */
  text: "#f5efe4",
  /** Texte secondaire et pied. */
  muted: "#bdb4a4",
  /** Filets et bordures. */
  line: "#263c58",
  /** Liens, surtitres, logo « judis ». */
  link: "#e8c98e",
  /** Fond du bouton principal (texte `navy`). */
  button: "#e8c98e",
} as const;

/** Origine du site pour les liens fixes de la marque (logo, pied) : jamais une préversion. */
export const EMAIL_SITE_URL = "https://immojudis.com";

/** Adresse de contact imprimée au pied de chaque email adressé à une personne. */
export const EMAIL_CONTACT_ADDRESS = "contact@immojudis.com";

/** Logos PNG (PNG-8, 288×64, affichés en 144×32), servis par `public/brand/email/`. */
export const EMAIL_LOGO_LIGHT_URL = `${EMAIL_SITE_URL}/brand/email/immojudis-logo-email-v1.png`;
export const EMAIL_LOGO_DARK_URL = `${EMAIL_SITE_URL}/brand/email/immojudis-logo-email-dark-v1.png`;

/**
 * En-tête des pages web d'arrivée des liens d'email (opposition de l'agent d'information) : barre or de
 * 6 px puis le nom « Immojudis ». Ce n'est PAS l'en-tête des emails : ceux-ci passent tous par
 * `emailLayout()` (`email-layout.ts`), avec le logo PNG.
 */
export function emailBrandHeaderHtml(): string {
  return `<div style="border-top:6px solid ${EMAIL_COLORS.gold};padding:14px 0 12px;"><span style="font-family:${EMAIL_FONT_STACK};font-size:22px;font-weight:800;letter-spacing:-.01em;color:${EMAIL_COLORS.navy};">${EMAIL_BRAND_NAME}</span></div>`;
}
