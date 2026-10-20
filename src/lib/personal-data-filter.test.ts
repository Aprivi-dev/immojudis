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

describe("redactPersonalText : temps linéaire sur de longues suites d'espaces", () => {
  const BUDGET_MS = 200;
  const spaces = (count: number) => " ".repeat(count);
  const texts: Record<string, string> = {
    "né et 20 000 espaces": `né${spaces(20000)}`,
    "née et 20 000 espaces": `Madame X, née${spaces(20000)}`,
    "demeurant et 20 000 espaces": `Madame X, demeurant${spaces(20000)}`,
    "20 000 espaces avant né": `${spaces(20000)}né le 3 mai 1950`,
    "20 000 espaces avant demeurant": `Madame X,${spaces(20000)}demeurant 3 rue A 75000 Paris`,
    "naissance répétée": `Madame X, née le 3 mai 1950${spaces(300)}`.repeat(200),
    "résidence répétée": `Madame X, demeurant 3 rue des Lilas 69000 Lyon${spaces(300)}`.repeat(200),
    "locataire répété": `Le locataire${spaces(300)}`.repeat(200),
    "bail consenti répété": `bail consenti${spaces(300)}`.repeat(200),
    "occupé par répété": `occupé par Madame Eva ROY${spaces(300)}`.repeat(200),
    "à la requête de répété": `à la requête de${spaces(300)}`.repeat(200),
    "à la requête de : répété": `à la requête de :${spaces(300)}la${spaces(300)}`.repeat(100),
    "rôle répété": `Le débiteur${spaces(300)}`.repeat(200),
    "rôle suivi d'un nom répété": `Le saisi, Paul${spaces(300)}ROY${spaces(300)}`.repeat(100),
    "NOM Prénom répété": `occupé par DUPONT${spaces(300)}Pierre${spaces(300)}`.repeat(100),
    "longue suite de noms en capitales": `occupé par ${"DUPONT ".repeat(5000)}`,
    "longue suite de prénoms": `Le saisi, ${"Pierre ".repeat(5000)}`,
    "longue suite de NOM Prénom": `occupé par ${"DUPONT Pierre ".repeat(3000)}`,
  };

  it.each(Object.entries(texts))("%s", (_name, text) => {
    const started = performance.now();
    redactPersonalText(text);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });

  it("retire toujours la naissance et la résidence avec leur séparateur", () => {
    expect(
      redactPersonalText("Madame X , née le 3 mai 1950 à Lyon , demeurant 3 rue A 75000 Paris."),
    ).toBe("Madame X.");
    expect(redactPersonalText("Madame X    née le 3 mai 1950 vend.")).toBe("Madame X vend.");
    const long = `Madame X, née le 3 mai 1950${spaces(300)}`.repeat(200);
    expect(redactPersonalText(long)).not.toContain("1950");
  });
});

describe("redactPersonalData", () => {
  it("parcourt les chaînes d'une valeur JSON sans toucher au reste", () => {
    const value = {
      a: ["Occupé par Monsieur Pierre DUPONT suivant bail", 3, null],
      b: { c: "À la requête de Madame Anne ROUX, demeurant 3 rue X 75000 Paris." },
    };
    expect(redactPersonalData(value)).toEqual({
      a: ["Occupé par un occupant suivant bail", 3, null],
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
      description: "Appartement occupé par un occupant suivant bail.",
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

describe("liste des prénoms", () => {
  it("est la même que celle du miroir Python (`_FIRST_NAMES`)", () => {
    const quoted = (source: string, start: RegExp) => {
      const block = new RegExp(`${start.source}([\\s\\S]*?)(?:;\\n|\\n\\)\\n)`).exec(source)![1];
      return [...block.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("");
    };
    const typescript = quoted(
      readFileSync(path.join(process.cwd(), "src/lib/personal-data-filter.ts"), "utf8"),
      /const FIRST_NAMES =/,
    );
    const python = quoted(
      readFileSync(path.join(process.cwd(), "services/data-pipeline/src/personal_data.py"), "utf8"),
      /_FIRST_NAMES = \(/,
    );

    expect(typescript.split(" ").length).toBeGreaterThan(300);
    expect(python).toBe(typescript);
  });
});

describe("champs filtrés", () => {
  const names = (source: string, start: RegExp) => {
    const block = new RegExp(`${start.source}([\\s\\S]*?)(?:\\]|\\n\\))`).exec(source)![1];
    return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("couvrent tous les champs du miroir Python (colonnes, clés du payload, observations)", () => {
    const python = read("services/data-pipeline/src/personal_data.py");
    const pythonNames = new Set([
      ...names(python, /SALE_TEXT_COLUMNS = \(/),
      ...names(python, /PAYLOAD_TEXT_KEYS = \(/),
      "observations", // `redact_storage_row` filtre aussi la liste des observations
    ]);
    const typescript = read("src/lib/personal-data-filter.ts");
    const typescriptNames = new Set([
      ...names(typescript, /const SALE_TEXT_FIELDS = \[/),
      ...names(typescript, /const SALE_JSON_FIELDS = \[/),
    ]);

    expect(pythonNames.size).toBeGreaterThan(10);
    expect([...pythonNames].filter((name) => !typescriptNames.has(name))).toEqual([]);
  });

  it("filtre les champs que Python filtrait déjà", () => {
    const sale = {
      source_conflicts: [{ field: "description", alternative: "occupé par Pierre Martin" }],
      llm_extraction: { occupancy_details: "Locataire Madame Sara LOPEZ" },
      llm_fact_extraction: { facts: ["bail consenti à Monsieur Olivier MOREAU"] },
      llm_display_source_constraints: ["occupé par Madame Julie ROBERT"],
      observations: [{ title: "Bien occupé par la famille Martin", city: "Lyon" }],
    };
    expect(redactSaleTexts(sale)).toEqual({
      source_conflicts: [{ field: "description", alternative: "occupé par un occupant" }],
      llm_extraction: { occupancy_details: "Locataire" },
      llm_fact_extraction: { facts: ["bail consenti à un locataire"] },
      llm_display_source_constraints: ["occupé par un occupant"],
      observations: [{ title: "Bien occupé par la famille", city: "Lyon" }],
    });
  });
});
