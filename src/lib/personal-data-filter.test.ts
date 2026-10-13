import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  redactPersonalData,
  redactPersonalText,
  redactSaleTexts,
} from "@/lib/personal-data-filter";

/**
 * Cas partagés avec le miroir Python (services/data-pipeline/src/personal_data.py,
 * tests/test_personal_data.py). Si ce test change, le miroir Python doit changer avec lui.
 */
type ChangedCase = { name: string; input: string; expected: string; absent: string[] };
type UnchangedCase = { name: string; input: string };

const fixturePath = path.join(
  process.cwd(),
  "services/data-pipeline/tests/fixtures/personal_data_filter_cases.json",
);
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  changed: ChangedCase[];
  unchanged: UnchangedCase[];
};

describe("redactPersonalText : cas partagés avec le filtre Python", () => {
  it.each(cases.changed)("réécrit : $name", ({ input, expected }) => {
    expect(redactPersonalText(input)).toBe(expected);
  });

  it.each(cases.changed)("ne laisse rien de personnel : $name", ({ input, absent }) => {
    const result = redactPersonalText(input);
    for (const fragment of absent) expect(result).not.toContain(fragment);
  });

  it.each(cases.changed)("est idempotent : $name", ({ input }) => {
    const once = redactPersonalText(input);
    expect(redactPersonalText(once)).toBe(once);
  });

  it.each(cases.unchanged)("laisse intact : $name", ({ input }) => {
    expect(redactPersonalText(input)).toBe(input);
  });
});

describe("redactPersonalText", () => {
  it("laisse passer les valeurs absentes", () => {
    expect(redactPersonalText(null)).toBeNull();
    expect(redactPersonalText(undefined)).toBeUndefined();
    expect(redactPersonalText("")).toBe("");
  });
});

describe("redactPersonalData", () => {
  it("parcourt les chaînes d'une valeur JSON sans toucher au reste", () => {
    const value = {
      a: ["Occupé par Monsieur Pierre DUPONT suivant bail", 3, null],
      b: { c: "À la requête de Madame Anne ROUX, demeurant 3 rue X 75000 Paris." },
    };
    expect(redactPersonalData(value)).toEqual({
      a: ["Occupé par un locataire suivant bail", 3, null],
      b: { c: "À la requête du créancier poursuivant." },
    });
    expect(value.a[0]).toContain("Monsieur Pierre DUPONT");
  });
});

describe("redactSaleTexts", () => {
  it("filtre les textes libres et les risques d'une fiche, pas ses faits structurés", () => {
    const sale = {
      id: "sale-1",
      city: "Lyon",
      occupancy_status: "rented",
      lawyer_contact: "Me X, avocat, demeurant 5 rue de la Paix 75002 Paris",
      description: "Appartement occupé par Monsieur Pierre DUPONT suivant bail.",
      source_description: "À la requête de Monsieur Henri FAURE, demeurant 1 rue A 75000 Paris.",
      llm_display_description: "Locataire Madame Sara LOPEZ, loyer 500 euros.",
      surface_evidence: "62 m² occupés par Madame Eva ROY",
      source_blocks: { detail: { Occupation: "occupé par Monsieur Luc PETIT" } },
      source_blocks_by_source: { "source:1": { Occupation: "locataire Madame Eva ROY" } },
      risks: [
        {
          risk_label: "Locataire en place",
          evidence: "bail consenti à Monsieur Olivier MOREAU",
          occurrences: [{ excerpt: "occupé par Madame Julie ROBERT" }],
        },
      ],
    };
    expect(redactSaleTexts(sale)).toEqual({
      ...sale,
      description: "Appartement occupé par un locataire suivant bail.",
      source_description: "À la requête du créancier poursuivant.",
      llm_display_description: "Locataire, loyer 500 euros.",
      surface_evidence: "62 m² occupés par un occupant",
      source_blocks: { detail: { Occupation: "occupé par un occupant" } },
      source_blocks_by_source: { "source:1": { Occupation: "locataire" } },
      risks: [
        {
          risk_label: "Locataire en place",
          evidence: "bail consenti à un locataire",
          occurrences: [{ excerpt: "occupé par un occupant" }],
        },
      ],
    });
    expect(sale.description).toContain("DUPONT");
  });

  it("conserve la forme d'une fiche sans texte libre", () => {
    const sale = { id: "sale-2", description: null, risks: null, source_blocks: null };
    expect(redactSaleTexts(sale)).toEqual(sale);
  });
});
