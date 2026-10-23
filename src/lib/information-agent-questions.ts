import { getKeyFactReliabilities, type FactReliabilityMap } from "@/lib/fact-reliability";
import {
  buildInformationAgentInventory,
  type InformationAgentInventory,
  type InformationAgentInventoryItem,
  type InformationAgentInventoryKey,
  type InformationAgentInventorySale,
  type InformationAgentMissingDocument,
} from "@/lib/information-agent-inventory";

/**
 * Questions posées au professionnel, écarts d'information détectés sur une fiche et leur ordre de
 * priorité. Module pur (aucun accès réseau ni base), réexporté par `information-agent.ts`.
 */

export const INFORMATION_AGENT_QUESTIONS = {
  sale_date: {
    label: "Date de vente",
    question:
      "Pouvez-vous confirmer la date, l'heure et le lieu de la vente de ce lot, ainsi que tout report ou changement annoncé ?",
  },
  starting_price_eur: {
    label: "Mise à prix",
    question:
      "Pouvez-vous confirmer la mise à prix applicable à ce lot et nous signaler toute correction publiée ?",
  },
  documents: {
    label: "Pièces du dossier",
    question:
      "Pourriez-vous transmettre le cahier des conditions de vente et les pièces consultables du dossier, ou nous indiquer où les consulter, en précisant leur date ou leur version si elle est connue ?",
  },
  photos: {
    label: "Photos complémentaires",
    question:
      "Pourriez-vous transmettre des photos complémentaires que vous êtes autorisé à partager, en précisant leur date approximative et les pièces ou annexes qu’elles montrent ?",
  },
  visit: {
    label: "Visites",
    question:
      "Quelles sont les prochaines dates de visite, les modalités d'inscription et le contact à utiliser pour confirmer sa venue ?",
  },
  occupancy: {
    label: "Occupation",
    question:
      "Le bien est-il actuellement libre, occupé ou loué ? Si le bien est loué, pouvez-vous préciser le loyer connu et signaler toute évolution récente ?",
  },
  surface: {
    label: "Surface",
    question:
      "Pouvez-vous confirmer séparément la surface habitable, la surface Carrez et, le cas échéant, la surface du terrain ?",
  },
  diagnostics: {
    label: "Diagnostics",
    question:
      "Les diagnostics techniques, notamment le DPE, sont-ils disponibles dans une version à jour ? Merci d'indiquer leur date et les classes connues.",
  },
  composition: {
    label: "Composition",
    question:
      "Pouvez-vous confirmer la composition du bien, le nombre de pièces et les éventuelles annexes en distinguant celles incluses dans le lot ?",
  },
  sale_terms: {
    label: "Modalités de vente",
    question:
      "Pouvez-vous confirmer les modalités d'enchère, le montant et la forme de la garantie à remettre avant d'enchérir (en saisie immobilière : 10 % de la mise à prix, 3 000 € au minimum, par chèque de banque ou caution bancaire), les frais annoncés et les délais applicables, dont celui de paiement du prix ?",
  },
  cadastre: {
    label: "Références cadastrales",
    question:
      "Pouvez-vous nous indiquer les références cadastrales du bien (section et numéro de parcelle) ?",
  },
} as const;

export type InformationAgentQuestionKey = keyof typeof INFORMATION_AGENT_QUESTIONS;

export type InformationAgentGap = {
  key: InformationAgentQuestionKey;
  label: string;
  reason: string;
  /** Higher values are asked first when the admin did not choose questions manually. */
  priority: number;
  /** A gap that can change the safety or feasibility of a bid. */
  blocking: boolean;
};

const QUESTION_PRIORITY: Record<InformationAgentQuestionKey, { score: number; blocking: boolean }> =
  {
    sale_date: { score: 96, blocking: true },
    starting_price_eur: { score: 92, blocking: true },
    documents: { score: 100, blocking: true },
    sale_terms: { score: 94, blocking: true },
    visit: { score: 88, blocking: true },
    occupancy: { score: 82, blocking: true },
    surface: { score: 72, blocking: false },
    diagnostics: { score: 70, blocking: false },
    composition: { score: 64, blocking: false },
    cadastre: { score: 56, blocking: false },
    photos: { score: 48, blocking: false },
  };

const MAX_DEFAULT_QUESTION_KEYS = 4;

export function selectDefaultInformationAgentQuestionKeys(
  gaps: readonly InformationAgentGap[],
): InformationAgentQuestionKey[] {
  if (!gaps.length) return [];
  return [...gaps]
    .sort((left, right) => right.priority - left.priority)
    .map((gap) => gap.key)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .slice(0, MAX_DEFAULT_QUESTION_KEYS);
}

export function detectInformationGaps(
  sale: InformationAgentInventorySale,
  facts: FactReliabilityMap = getKeyFactReliabilities(sale),
  inventory: InformationAgentInventory = buildInformationAgentInventory(sale, facts),
): InformationAgentGap[] {
  const gaps: InformationAgentGap[] = [];
  const byKey = new Map(inventory.items.map((entry) => [entry.key, entry]));
  const open = (key: InformationAgentInventoryKey) => {
    const entry = byKey.get(key);
    return entry && (entry.status === "missing" || entry.status === "to_confirm") ? entry : null;
  };

  // Date et lieu partagent une question : la date d'audience (ou limite) et, s'il manque, le lieu.
  const hearing = open("hearing");
  const venue = open("venue");
  const dateOrVenue = hearing ?? venue;
  if (dateOrVenue) {
    addGap(
      gaps,
      "sale_date",
      [hearing?.detail, venue?.detail].filter(Boolean).join(" "),
      criticalPriority("sale_date", dateOrVenue),
    );
  }
  const price = open("starting_price");
  if (price) {
    addGap(gaps, "starting_price_eur", price.detail, criticalPriority("starting_price_eur", price));
  }

  if (inventory.missingDocuments.length) {
    const names = inventory.missingDocuments.map((key) => MISSING_DOCUMENT_NAMES[key]);
    addGap(
      gaps,
      "documents",
      `Pièces absentes : ${names.join(", ")}.`,
      inventory.missingDocuments.includes("sale_conditions")
        ? QUESTION_PRIORITY.documents.score
        : inventory.missingDocuments.includes("pv_descriptif")
          ? 84
          : QUESTION_PRIORITY.diagnostics.score,
    );
  }
  const photos = open("photos");
  if (photos) {
    addGap(
      gaps,
      "photos",
      photos.detail,
      QUESTION_PRIORITY.photos.score + (photos.status === "missing" ? 10 : 0),
    );
  }
  const visits = open("visits");
  if (visits) addGap(gaps, "visit", visits.detail);
  const occupancy = open("occupancy");
  if (occupancy) {
    addGap(gaps, "occupancy", occupancy.detail, criticalPriority("occupancy", occupancy));
  }
  const surface = open("surface");
  if (surface) addGap(gaps, "surface", surface.detail, criticalPriority("surface", surface));
  const cadastre = open("cadastre");
  if (cadastre) addGap(gaps, "cadastre", cadastre.detail);
  const composition = open("composition");
  if (composition) addGap(gaps, "composition", composition.detail);
  // Le cahier des conditions de vente, déjà demandé, fixe garantie à remettre pour enchérir, frais et délais : la
  // question des modalités ferait doublon et prendrait la place d'une question utile.
  const terms = inventory.missingDocuments.includes("sale_conditions") ? null : open("sale_terms");
  if (terms) addGap(gaps, "sale_terms", terms.detail);

  return gaps;
}

const MISSING_DOCUMENT_NAMES: Record<InformationAgentMissingDocument, string> = {
  sale_conditions: "le cahier des conditions de vente",
  pv_descriptif: "le procès-verbal descriptif",
  diagnostics: "le dossier de diagnostics techniques",
};

/** Contexte qui précise le libellé de certaines questions (pièces manquantes, type de vente). */
export type InformationAgentQuestionContext = {
  judicial: boolean;
  venueMissing: boolean;
  missingDocuments: readonly InformationAgentMissingDocument[];
};

export function informationAgentQuestionContext(
  inventory: InformationAgentInventory,
): InformationAgentQuestionContext {
  return {
    judicial: inventory.judicial,
    venueMissing: inventory.items.some(
      (entry) => entry.key === "venue" && entry.status === "missing",
    ),
    missingDocuments: inventory.missingDocuments,
  };
}

/** Libellé exact d'une question : les pièces et la date sont nommées selon la fiche. */
export function informationAgentQuestionText(
  key: InformationAgentQuestionKey,
  context?: InformationAgentQuestionContext,
): string {
  if (key === "documents" && context?.missingDocuments.length) {
    const names = context.missingDocuments.map((entry) => MISSING_DOCUMENT_NAMES[entry]);
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`
        : names[0];
    return `Pourriez-vous nous transmettre ${list}, ou nous indiquer où les consulter, en précisant leur date ou leur version si elle est connue ?`;
  }
  if (key === "sale_date" && context) {
    if (context.judicial) {
      return `Pouvez-vous confirmer la date et l'heure de l'audience d'adjudication${
        context.venueMissing ? ", ainsi que le tribunal où elle se tient," : ""
      } et nous signaler tout report annoncé ?`;
    }
    return `Pouvez-vous confirmer la date de la vente ou la date limite de dépôt des offres${
      context.venueMissing ? ", ainsi que le lieu ou la plateforme de vente," : ""
    } et nous signaler tout report annoncé ?`;
  }
  return INFORMATION_AGENT_QUESTIONS[key].question;
}

function addGap(
  gaps: InformationAgentGap[],
  key: InformationAgentQuestionKey,
  reason: string,
  priority = QUESTION_PRIORITY[key].score,
) {
  gaps.push({
    key,
    label: INFORMATION_AGENT_QUESTIONS[key].label,
    reason,
    priority,
    blocking: QUESTION_PRIORITY[key].blocking,
  });
}

/**
 * Priorité d'une question portant sur un fait clé : une contradiction passe devant tout, une
 * valeur absente avant une valeur simplement estimée.
 */
function criticalPriority(
  key: InformationAgentQuestionKey,
  entry: Pick<InformationAgentInventoryItem, "status" | "detail">,
): number {
  const base = QUESTION_PRIORITY[key].score;
  if (entry.status === "missing") return base + 10;
  return /contredisent/.test(entry.detail) ? base + 40 : base + 5;
}
