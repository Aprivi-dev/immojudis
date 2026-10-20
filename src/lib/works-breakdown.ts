/**
 * Détail de vos travaux (point 74) : postes saisis par l'utilisateur, quantité et coût unitaire de
 * son choix, dont le total alimente le budget travaux du calcul de l'enchère plafond.
 *
 * Immojudis ne fournit AUCUN prix ici : pas de grille, pas de montant suggéré, pas de valeur par
 * défaut. Les montants sont ceux de l'utilisateur, sans valeur de devis. Aucune notion fiscale
 * (TVA, régime) : le total est la somme des quantités × coûts saisis, rien d'autre.
 *
 * Les postes sont sauvegardés avec les autres hypothèses du calculateur (voir
 * `use-ceiling-choices.ts`, navigateur seulement) : aucune donnée n'est envoyée au serveur.
 */

export const WORKS_BREAKDOWN_KINDS = [
  { key: "toiture", label: "Toiture" },
  { key: "facade", label: "Façade" },
  { key: "electricite", label: "Électricité" },
  { key: "plomberie", label: "Plomberie" },
  { key: "chauffage", label: "Chauffage" },
  { key: "menuiseries", label: "Menuiseries" },
  { key: "isolation", label: "Isolation" },
  { key: "cuisine", label: "Cuisine" },
  { key: "salle_de_bains", label: "Salle de bains" },
  { key: "sols", label: "Sols" },
  { key: "peinture", label: "Peinture" },
  { key: "autre", label: "Autre" },
] as const;

export type WorksBreakdownKind = (typeof WORKS_BREAKDOWN_KINDS)[number]["key"];

/** Poste de travaux. Les nombres restent du texte saisi : un champ à moitié rempli reste affiché. */
export type WorksBreakdownItem = {
  id: string;
  /** `""` tant que l'utilisateur n'a pas choisi le poste. */
  kind: WorksBreakdownKind | "";
  /** Précision libre, utile surtout pour « Autre ». */
  label: string;
  quantity: string;
  /** Unité de la quantité (m², forfait…), texte libre. */
  unit: string;
  /** Coût d'une unité, en euros. */
  unitCost: string;
};

export const MAX_WORKS_BREAKDOWN_ITEMS = 30;
const MAX_TEXT_LENGTH = 60;
const MAX_UNIT_LENGTH = 12;
const MAX_NUMBER_LENGTH = 20;
/** Bornes de bon sens : au-delà, la saisie est une faute de frappe, pas un poste. */
const MAX_QUANTITY = 1_000_000;
const MAX_UNIT_COST = 10_000_000;

const KIND_KEYS = new Set<string>(WORKS_BREAKDOWN_KINDS.map((kind) => kind.key));

export function worksBreakdownKindLabel(kind: WorksBreakdownKind | ""): string {
  return WORKS_BREAKDOWN_KINDS.find((item) => item.key === kind)?.label ?? "Poste à choisir";
}

export function emptyWorksBreakdownItem(id: string): WorksBreakdownItem {
  return { id, kind: "", label: "", quantity: "", unit: "", unitCost: "" };
}

/** Nombre décimal saisi à la française ou à l'anglaise (virgule ou point), ou `null`. */
export function parseWorksNumber(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Total d'un poste (quantité × coût unitaire), ou `null` tant que le poste n'est pas complet : poste
 * choisi, quantité strictement positive et coût renseigné (0 € reste un coût).
 */
export function worksBreakdownLineTotal(item: WorksBreakdownItem): number | null {
  if (!item.kind) return null;
  const quantity = parseWorksNumber(item.quantity);
  const unitCost = parseWorksNumber(item.unitCost);
  if (quantity == null || quantity <= 0 || quantity > MAX_QUANTITY) return null;
  if (unitCost == null || unitCost > MAX_UNIT_COST) return null;
  return quantity * unitCost;
}

export type WorksBreakdownSummary = {
  /** Somme des postes complets, arrondie à l'euro. */
  total: number;
  complete: number;
  /** Postes commencés mais pas complets : ils ne comptent pas dans le total. */
  incomplete: number;
};

export function summarizeWorksBreakdown(
  items: readonly WorksBreakdownItem[],
): WorksBreakdownSummary {
  let sum = 0;
  let complete = 0;
  for (const item of items) {
    const total = worksBreakdownLineTotal(item);
    if (total == null) continue;
    sum += total;
    complete += 1;
  }
  return { total: Math.round(sum), complete, incomplete: items.length - complete };
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

/** Garde les postes valides d'un brouillon stocké (entrée non fiable) ; le reste est ignoré. */
export function parseWorksBreakdown(raw: unknown): WorksBreakdownItem[] {
  if (!Array.isArray(raw)) return [];
  const items: WorksBreakdownItem[] = [];
  for (const entry of raw.slice(0, MAX_WORKS_BREAKDOWN_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = text(value.id, 40) || `poste-${items.length}`;
    items.push({
      id: items.some((item) => item.id === id) ? `${id}-${items.length}` : id,
      kind:
        typeof value.kind === "string" && KIND_KEYS.has(value.kind)
          ? (value.kind as WorksBreakdownKind)
          : "",
      label: text(value.label, MAX_TEXT_LENGTH),
      quantity: text(value.quantity, MAX_NUMBER_LENGTH),
      unit: text(value.unit, MAX_UNIT_LENGTH),
      unitCost: text(value.unitCost, MAX_NUMBER_LENGTH),
    });
  }
  return items;
}

export const WORKS_BREAKDOWN_LIMITS = {
  label: MAX_TEXT_LENGTH,
  unit: MAX_UNIT_LENGTH,
  number: MAX_NUMBER_LENGTH,
} as const;
