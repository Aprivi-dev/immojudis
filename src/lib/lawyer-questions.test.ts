import { describe, expect, it } from "vitest";
import {
  INFORMATION_AGENT_QUESTIONS,
  informationAgentQuestionText,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import type { AuctionSale } from "@/lib/types";
import { buildLawyerQuestions, inFirstPersonSingular } from "./lawyer-questions";
import { lawyerQuestionsText } from "./lawyer-questions-text";

function incompleteSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Appartement T3 à Bordeaux",
    property_type: "apartment",
    postal_code: "33000",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    sale_venue_type: "tribunal",
    sale_date: "2026-12-14T09:00:00.000Z",
    starting_price_eur: 85_000,
    documents: null,
    documents_rich: null,
    media: null,
    visit_dates: null,
    occupancy_status: null,
    app_surface_m2: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
    app_surface_kind: null,
    surface_scope: null,
    rooms_count: null,
    sale_procedure: null,
    ...overrides,
  } as AuctionSale;
}

describe("inFirstPersonSingular", () => {
  it("passe « nous » à la première personne du singulier, avec l'élision", () => {
    expect(inFirstPersonSingular("ou nous indiquer où les consulter")).toBe(
      "ou m’indiquer où les consulter",
    );
    expect(inFirstPersonSingular("nous signaler tout report")).toBe("me signaler tout report");
    expect(inFirstPersonSingular("Pourriez-vous nous transmettre le cahier")).toBe(
      "Pourriez-vous me transmettre le cahier",
    );
  });
});

describe("buildLawyerQuestions", () => {
  it("tire les questions des points que la fiche laisse ouverts, les plus importants d'abord", () => {
    const questions = buildLawyerQuestions(incompleteSale());
    const keys = questions.map((entry) => entry.key);

    // Ni la date ni la mise à prix ne manquent ; l'occupation, la surface et les pièces, si.
    expect(keys).toEqual(expect.arrayContaining(["documents", "occupancy", "surface"]));
    expect(keys).not.toContain("starting_price_eur");
    expect(keys).not.toContain("sale_date");
    const priorities = questions.map((entry) => entry.blocking);
    expect(priorities.indexOf(false)).toBeGreaterThan(priorities.lastIndexOf(true));
    // Le motif est celui de la fiche, la question celle de l'agent d'information.
    const occupancy = questions.find((entry) => entry.key === "occupancy")!;
    expect(occupancy.label).toBe("Occupation");
    expect(occupancy.reason.length).toBeGreaterThan(0);
    expect(occupancy.question).toBe(INFORMATION_AGENT_QUESTIONS.occupancy.question);
  });

  it("nomme les pièces absentes et ne parle jamais au nom d'Immojudis", () => {
    const questions = buildLawyerQuestions(incompleteSale());
    const documents = questions.find((entry) => entry.key === "documents")!;
    expect(documents.question).toContain("le cahier des conditions de vente");
    expect(documents.question).toContain("me transmettre");
    for (const entry of questions) {
      expect(entry.question).not.toMatch(/\b(nous|nos|notre)\b/i);
    }
  });

  it("n'a plus aucun « nous » pour aucune des questions prévues", () => {
    for (const key of Object.keys(INFORMATION_AGENT_QUESTIONS) as InformationAgentQuestionKey[]) {
      for (const judicial of [true, false]) {
        const text = informationAgentQuestionText(key, {
          judicial,
          venueMissing: true,
          missingDocuments: ["sale_conditions", "pv_descriptif", "diagnostics"],
        });
        expect(inFirstPersonSingular(text)).not.toMatch(/\b(nous|nos|notre)\b/i);
      }
    }
  });

  it("pose la question de la date quand la fiche n'en a pas", () => {
    const questions = buildLawyerQuestions(incompleteSale({ sale_date: null }));
    const date = questions.find((entry) => entry.key === "sale_date");
    expect(date?.question).toContain("me signaler tout report annoncé");
  });
});

describe("lawyerQuestionsText", () => {
  it("numérote les questions sous le titre, sans motif ni donnée de compte", () => {
    const questions = buildLawyerQuestions(incompleteSale());
    const text = lawyerQuestionsText(questions, "Mes questions pour l’avocat");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Mes questions pour l’avocat");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(`1. ${questions[0].question}`);
    expect(lines).toHaveLength(2 + questions.length);
  });
});
