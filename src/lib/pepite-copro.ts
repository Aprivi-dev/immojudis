// Copropriété en difficulté (règle pepite-v1.2 et suivantes, critère bloquant `no_copro_distress`). Fonction PURE :
// elle lit les points de la « lecture des pièces » (`auction_document_readings.points`, `document-reading.ts`),
// thème « copropriété », et reconnaît quatre mentions EXPLICITES, et rien d'autre (en particulier pas
// « absence de syndic ») :
//   - « administrateur provisoire » ;
//   - « plan de sauvegarde » ;
//   - « mandataire ad hoc » ;
//   - « carence », SAUF « carence d'enchères » (une vente sans enchérisseur n'est pas une copropriété en difficulté).
// La recherche ignore la casse, les accents, les apostrophes typographiques et les traits d'union. Elle ne lit pas
// les négations (« pas d'administrateur provisoire ») : une mention suffit, ce qui est la lecture prudente pour un
// critère bloquant. Module sans donnée ni import serveur.
import type { DocumentReadingPoint } from "@/lib/document-reading";

export type CoproDistressKind =
  | "administrateur_provisoire"
  | "plan_de_sauvegarde"
  | "mandataire_ad_hoc"
  | "carence";

/** Le thème des points lus : seul « copropriété » compte. */
export const COPRO_DISTRESS_THEME = "copropriete" as const;

/** Ce que la détection lit d'un point de la lecture des pièces. */
export type CoproReadingPoint = Pick<
  DocumentReadingPoint,
  "theme" | "title" | "explanation" | "quote"
>;

const EXPLICIT_MENTIONS: ReadonlyArray<{ kind: CoproDistressKind; pattern: RegExp }> = [
  { kind: "administrateur_provisoire", pattern: /\badministrateur provisoire\b/ },
  { kind: "plan_de_sauvegarde", pattern: /\bplan de sauvegarde\b/ },
  { kind: "mandataire_ad_hoc", pattern: /\bmandataire ad hoc\b/ },
];

/** Minuscules, sans accent, apostrophes et traits d'union ramenés à l'espace ou à `'`, espaces réduits. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[‐-―-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** « carence » suivi de « d'enchères » (ou « de enchères », au singulier ou au pluriel) : pas une difficulté de copropriété. */
const AUCTION_DEFAULT_AFTER_CARENCE = /^ ?(?:d ?'? ?|de )encheres?\b/;

function mentionsCarence(normalized: string): boolean {
  for (const match of normalized.matchAll(/\bcarence\b/g)) {
    const after = normalized.slice((match.index ?? 0) + match[0].length);
    if (!AUCTION_DEFAULT_AFTER_CARENCE.test(after)) return true;
  }
  return false;
}

/** Les mentions explicites trouvées dans un texte. */
export function coproDistressKindsInText(text: string): CoproDistressKind[] {
  const normalized = normalize(text);
  const kinds: CoproDistressKind[] = EXPLICIT_MENTIONS.filter(({ pattern }) =>
    pattern.test(normalized),
  ).map(({ kind }) => kind);
  if (mentionsCarence(normalized)) kinds.push("carence");
  return kinds;
}

/** Les mentions de difficulté trouvées dans les points « copropriété » (titre, explication et citation). */
export function coproDistressKinds(points: readonly CoproReadingPoint[]): CoproDistressKind[] {
  const found = new Set<CoproDistressKind>();
  for (const point of points) {
    if (point.theme !== COPRO_DISTRESS_THEME) continue;
    const text = [point.title, point.explanation, point.quote].filter(Boolean).join(" \n ");
    for (const kind of coproDistressKindsInText(text)) found.add(kind);
  }
  return [...found];
}

/** Une pièce lue mentionne-t-elle explicitement une copropriété en difficulté ? */
export function hasCoproDistress(points: readonly CoproReadingPoint[] | null | undefined): boolean {
  return points != null && coproDistressKinds(points).length > 0;
}
