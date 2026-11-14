/**
 * Les six sections de la fiche, sur une seule page (sommaire numéroté collant), et le chemin des
 * ancres vers elles : les ancres de section, celles des anciens onglets (`#estimation`, `#travaux`…)
 * et celles des blocs (`#calculation`, `#urbanism`, `#rendez-vous`…) mènent toutes à la bonne section.
 */
export type SaleDetailSection =
  | "bien"
  | "prix"
  | "marche"
  | "travaux-financement"
  | "pieces"
  | "demarches";

export const SALE_DETAIL_SECTIONS: ReadonlyArray<{
  id: SaleDetailSection;
  number: string;
  label: string;
  /** Libellé court des pilules du sommaire sur téléphone. */
  shortLabel: string;
}> = [
  { id: "bien", number: "01", label: "Le bien", shortLabel: "Le bien" },
  { id: "prix", number: "02", label: "Prix et plafond", shortLabel: "Plafond" },
  { id: "marche", number: "03", label: "Marché et comparables", shortLabel: "Comparables" },
  {
    id: "travaux-financement",
    number: "04",
    label: "Travaux et financement",
    shortLabel: "Financement",
  },
  { id: "pieces", number: "05", label: "Pièces du dossier", shortLabel: "Pièces" },
  { id: "demarches", number: "06", label: "Démarches", shortLabel: "Démarches" },
];

/** Section 05 « Pièces du dossier » : cible du lien « Où consulter le cahier » des mentions de l'avocat. */
export const SALE_DETAIL_PIECES_HREF = `#${"pieces" satisfies SaleDetailSection}`;

export type LegacyDetail =
  | "market"
  | "budget"
  | "participation"
  | "documents"
  | "tribunal-perspective";

const STATISTICS_ANCHORS = [
  "statistiques",
  "tribunal-history",
  "stats-overview",
  "stats-ventes",
  "stats-chiffres",
  "stats-adjudications",
  "stats-calendrier",
  "stats-avocats",
  "stats-communes",
  "stats-methode",
];

const SECTION_ANCHORS: Record<SaleDetailSection, readonly string[]> = {
  bien: [
    "bien",
    // Ancien onglet Aperçu et ses blocs.
    "apercu",
    "description-ia",
    "localisation",
    "caracteristiques",
    "risks",
    "points-a-verifier",
    // Bloc « Pourquoi cette pépite » : en tête de la section.
    "pepite",
  ],
  prix: [
    "prix",
    "estimation",
    "budget",
    "budget-analysis",
    "summary",
    "calculation",
    "why-this-ceiling",
    "tribunal-perspective",
    "scenarios",
    "historique",
  ],
  marche: ["marche", "market", "quartier", "urbanism"],
  "travaux-financement": ["travaux-financement", "travaux", "works", "financement", "financing"],
  pieces: ["pieces", "documents", "lecture-pieces"],
  demarches: ["demarches", "rendez-vous", "participation", "lawyer", "sale-timeline"],
};

export function legacyDetailForAnchor(anchor: string, budgetTarget: string): LegacyDetail | null {
  if (["budget", "budget-analysis", "calculation"].includes(anchor)) {
    return budgetTarget === "budget" ? "budget" : null;
  }
  if (["market", "participation", "documents", "tribunal-perspective"].includes(anchor)) {
    return anchor as LegacyDetail;
  }
  return null;
}

/**
 * La section d'une ancre connue, `null` pour une ancre hors des sections (`#mon-dossier`, la carte
 * de déblocage…). Les statistiques du tribunal restent fermées tant que leur drapeau l'est : leurs
 * ancres ramènent alors en haut de la fiche.
 */
export function sectionForAnchor(anchor: string, allowStatistics = true): SaleDetailSection | null {
  if (STATISTICS_ANCHORS.includes(anchor)) return allowStatistics ? "marche" : "bien";
  for (const section of SALE_DETAIL_SECTIONS) {
    if (SECTION_ANCHORS[section.id].includes(anchor)) return section.id;
  }
  return null;
}

/**
 * Fait défiler jusqu'à l'ancre, ouvre les blocs repliés qui la contiennent. Une ancre dont le bloc
 * n'existe pas pour ce compte (ou n'est pas encore chargé) mène au bloc le plus proche, sinon au
 * début de sa section.
 */
export function revealAnchor(anchor: string, budgetTarget: string, allowStatistics = true) {
  const fallback = ["budget", "budget-analysis", "calculation"].includes(anchor)
    ? budgetTarget
    : anchor === "professional-pilot"
      ? "mon-dossier"
      : ["tribunal-perspective", "why-this-ceiling"].includes(anchor)
        ? "summary"
        : null;
  const section = sectionForAnchor(anchor, allowStatistics);
  const target =
    document.getElementById(anchor) ??
    (fallback ? document.getElementById(fallback) : null) ??
    (section ? document.getElementById(section) : null);
  if (!target) return;
  let parent = target.closest("details");
  while (parent) {
    parent.open = true;
    parent = parent.parentElement?.closest("details") ?? null;
  }
  target.scrollIntoView?.({ block: "start" });
}
