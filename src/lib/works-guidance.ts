import type { WorksScenarioKey } from "@/lib/profitability";

export type WorksSuggestion = {
  /** `null`: the description points to a property taken as is. */
  scenario: WorksScenarioKey | null;
  reason: string;
};

const NORMALIZE = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Suggests a works scenario from the condition published for the property
 * (« État du bien ») and its DPE class. It is only a suggestion: no budget is
 * retained until the user picks a scenario.
 */
export function suggestWorksScenario(
  condition: string | null | undefined,
  dpeClass: string | null | undefined,
): WorksSuggestion | null {
  const text = condition ? NORMALIZE(condition) : "";
  const quoted = condition ? `l’état décrit (« ${condition.trim()} »)` : "";
  if (text) {
    if (
      /degrad|insalubr|ruine|rehabilit|gros travaux|tout a refaire|a renover entierement|sinistr/.test(
        text,
      )
    ) {
      return { scenario: "premium", reason: `Suggéré par ${quoted}.` };
    }
    if (/renov|moderniser|travaux importants|a remettre aux normes|vetuste/.test(text)) {
      return { scenario: "confort", reason: `Suggéré par ${quoted}.` };
    }
    if (/rafraich|peinture|remise en etat|petits travaux|travaux legers|entretien/.test(text)) {
      return { scenario: "rafraichissement", reason: `Suggéré par ${quoted}.` };
    }
    if (/tres bon etat|bon etat|refait a neuf|renove|neuf|excellent/.test(text)) {
      return { scenario: null, reason: `Suggéré par ${quoted}.` };
    }
  }
  const dpe = dpeClass?.trim().toUpperCase();
  if (dpe === "F" || dpe === "G") {
    return {
      scenario: "confort",
      reason: `Suggéré par la classe DPE ${dpe} : une rénovation énergétique sera nécessaire pour louer.`,
    };
  }
  return null;
}

export type DpeRentalNote = { tone: "risk" | "watch" | "neutral"; text: string };

/**
 * Rental ban calendar of the loi Climat et résilience (n° 2021-1104, art. 160)
 * for metropolitan France. Overseas departments follow a later calendar.
 */
export function dpeRentalNote(dpeClass: string | null | undefined): DpeRentalNote | null {
  const dpe = dpeClass?.trim().toUpperCase();
  if (!dpe || !/^[A-G]$/.test(dpe)) return null;
  if (dpe === "G") {
    return {
      tone: "risk",
      text: "Classe G : logement interdit à la nouvelle location depuis le 1er janvier 2025 en métropole. Une rénovation énergétique est indispensable pour le louer.",
    };
  }
  if (dpe === "F") {
    return {
      tone: "risk",
      text: "Classe F : logement interdit à la location à partir du 1er janvier 2028 en métropole. Prévoyez une rénovation énergétique pour louer au-delà.",
    };
  }
  if (dpe === "E") {
    return {
      tone: "watch",
      text: "Classe E : logement interdit à la location à partir du 1er janvier 2034 en métropole. À intégrer dans un projet locatif de long terme.",
    };
  }
  return {
    tone: "neutral",
    text: `Classe ${dpe} : aucune interdiction de location prévue par la loi Climat et résilience.`,
  };
}
