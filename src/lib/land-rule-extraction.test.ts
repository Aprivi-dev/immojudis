import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractLandRulesFromPages,
  fetchLandRules,
  type LandRuleExtractionInput,
} from "./land-rule-extraction";
import type { LandPlanningResult } from "./land-report-types";

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfMocks.getDocument,
}));

const extractionInput = (
  overrides: Partial<LandRuleExtractionInput> = {},
): LandRuleExtractionInput => ({
  documentId: "plui-test",
  documentName: "règlement.pdf",
  sourceUrl: "https://data.geopf.fr/annexes/gpu/reglement.pdf",
  targetZoneLabels: ["UCa2"],
  pages: [
    {
      page: 73,
      text: [
        "ZONE UCa2",
        "Article UC3 - Emprise au sol",
        "L'emprise au sol est limitée à 60 % de l'unité foncière, sous réserve des dispositions particulières.",
        "Article UC4 - Hauteur",
        "La hauteur maximale peut atteindre R+4 lorsque les conditions de l'article sont respectées.",
      ].join("\n"),
    },
  ],
  totalPages: 1,
  coverageComplete: true,
  checkedAt: "2026-10-02T12:00:00.000Z",
  ...overrides,
});

describe("land rule extraction", () => {
  beforeEach(() => {
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              { str: "ZONE UCa2", transform: [1, 0, 0, 1, 0, 10] },
              {
                str: "Article UC3 : l'emprise au sol ne peut excéder 60%.",
                transform: [1, 0, 0, 1, 0, 8],
              },
            ],
          }),
        }),
      }),
      destroy: async () => undefined,
    });
  });

  it("keeps verbatim zone rules with page, article and conditions as proof", () => {
    const result = extractLandRulesFromPages(extractionInput());

    expect(result.completeCoverage).toBe(true);
    expect(result.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "footprint",
          page: 73,
          zoneLabels: ["UCa2"],
          article: "Article UC3",
          text: expect.stringContaining("60 %"),
          conditions: [expect.stringContaining("sous réserve")],
          confidence: "extracted",
        }),
        expect.objectContaining({
          topic: "height",
          text: expect.stringContaining("R+4"),
          article: "Article UC4",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(/droit disponible|autorisation de surélever/iu);
  });

  it("does not attach a neighbouring zone's rule to the requested parcel", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 77,
            text: "ZONE UB\nLa hauteur maximale est fixée à R+3 et l'emprise à 40 %.",
          },
        ],
      }),
    );

    expect(result.rules).toEqual([]);
    expect(result.completeCoverage).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/zone cible|règle exploitable/iu);
  });

  it("keeps a shared sector clause but excludes the neighbouring sector bullet", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 77,
            text: [
              "3.2.1 Dispositions générales",
              "- Dans les secteurs UCa1 et UCa2 : la hauteur maximale peut atteindre R+4.",
              "- Dans le secteur UCb2 : la hauteur maximale peut atteindre R+10.",
            ].join("\n"),
          },
        ],
      }),
    );

    const heightRules = result.rules.filter((rule) => rule.topic === "height");
    expect(heightRules.some((rule) => rule.text.includes("UCa1 et UCa2"))).toBe(true);
    expect(heightRules.every((rule) => !rule.text.includes("UCb2"))).toBe(true);
    expect(heightRules.every((rule) => !rule.text.includes("R+10"))).toBe(true);
  });

  it("recognises only article references with a code or number", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 74,
            text: [
              "ZONE UCa2",
              "Article R151 -21 : emprise au sol des constructions.",
              "Les dispositions du présent article s'appliquent.",
            ].join("\n"),
          },
          {
            page: 75,
            text: ["ZONE UCa2", "Article 3.2.1 : la hauteur maximale est à vérifier."].join("\n"),
          },
        ],
        totalPages: 2,
      }),
    );

    expect(result.rules.map((rule) => rule.article)).toContain("Article R151-21");
    expect(result.rules.map((rule) => rule.article)).toContain("Article 3.2.1");
    expect(result.rules.map((rule) => rule.article)).not.toContain("Article S");
  });

  it("extends snippets through PDF line wraps and keeps complete numeric phrases", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 77,
            text: [
              "ZONE UCa2",
              "3.1 Emprise au sol des constructions",
              "3.1.1 Conditions d'application des dispositions",
              "- Les dispositions s'appliquent après division foncière à l'échelle de chaque terrain issu de la division.",
              "3.2.1 Dispositions générales",
              "- Dans les secteurs UCa1 et UCa2 : la hauteur maximale peut atteindre 4 niveaux sur",
              "rez-de-chaussée (R+4).",
              "- La hauteur minimale est inférieure ou égale à 5",
              "mètres.",
              "- L'emprise au sol des constructions ne peut excéder 60% et les installations ne sont pas",
              "soumises à l'emprise au sol maximale.",
            ].join("\n"),
          },
        ],
      }),
    );

    expect(result.rules.some((rule) => rule.text.includes("rez-de-chaussée (R+4)."))).toBe(true);
    expect(result.rules.some((rule) => rule.text.includes("inférieure ou égale à 5 mètres."))).toBe(
      true,
    );
    expect(result.rules.some((rule) => rule.text.includes("ne sont pas soumises"))).toBe(true);
    const footprintTexts = result.rules
      .filter((rule) => rule.topic === "footprint")
      .map((rule) => rule.text);
    expect(footprintTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("après division foncière"),
        expect.stringContaining("ne peut excéder 60%"),
        expect.stringContaining("ne sont pas soumises"),
      ]),
    );
    expect(result.rules.every((rule) => !rule.text.endsWith("sur"))).toBe(true);
    expect(
      result.rules.every(
        (rule) => !/^(?:soumises|l['’]égout|rez-de-chaussée|2 et la hauteur)/iu.test(rule.text),
      ),
    ).toBe(true);
    expect(
      result.rules.every((rule) => !/^3\.1 Emprise au sol des constructions$/u.test(rule.text)),
    ).toBe(true);
  });

  it("attaches nested o sub-bullets to their parent and keeps their rubrique context", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 78,
            text: [
              "Communauté d'Agglomération du Saint-Quentinois",
              "PLUi-HD Communauté d'Agglomération du Saint-Quentinois - Règlement 77",
              "ZONE UCa2",
              "3.2 Hauteur des constructions",
              "3.2.2 Dispositions particulières",
              "- Les extensions des constructions existantes non conformes doivent être réalisées :",
              "o soit dans le respect des dispositions de l'article 3.2.1,",
              "o soit dans le prolongement de la hauteur de la construction existante.",
              "3.4 Implantation des constructions par rapport aux limites séparatives",
              "3.4.1 Conditions d'application des dispositions",
              "- Les dispositions du présent article s'appliquent :",
              "o après division foncière à l'échelle de chaque terrain issu de la division ;",
              "o pour tous les niveaux des constructions ;",
              "o sauf prescriptions spécifiques fixées par les OAP.",
            ].join("\n"),
          },
        ],
      }),
    );

    const heightRules = result.rules.filter((rule) => rule.topic === "height");
    expect(
      heightRules.some(
        (rule) =>
          rule.text.includes("Les extensions") &&
          rule.text.includes("article 3.2.1") &&
          rule.text.includes("prolongement de la hauteur"),
      ),
    ).toBe(true);
    expect(
      result.rules.some(
        (rule) =>
          rule.topic === "setbacks" &&
          rule.text.includes("3.4.1") &&
          rule.text.includes("après division") &&
          rule.text.includes("pour tous les niveaux"),
      ),
    ).toBe(true);
    expect(result.rules.every((rule) => !/^o\s/iu.test(rule.text))).toBe(true);
    expect(result.rules.every((rule) => !/^PLUi\b/iu.test(rule.text))).toBe(true);
  });

  it("rejects an indented sub-bullet when no parent rule can be demonstrated", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 79,
            text: [
              "PLUi-HD Règlement 78",
              "ZONE UCa2",
              "o pour tous les niveaux des constructions.",
            ].join("\n"),
          },
        ],
      }),
    );

    expect(result.rules).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Aucune règle exploitable/iu);
  });

  it("keeps an annex height exception under implantation instead of height", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 80,
            text: [
              "PLUi-HD Règlement 79",
              "ZONE UCa2",
              "3.4 Implantation des constructions par rapport aux limites séparatives",
              "3.4.3 Dispositions particulières",
              "- Les constructions à usage d'annexes dont l'emprise au sol est inférieure à 35 m2 et la hauteur inférieure à 3,5 m n'est pas règlementée.",
            ].join("\n"),
          },
        ],
      }),
    );

    expect(
      result.rules.some(
        (rule) =>
          rule.topic === "setbacks" &&
          rule.text.includes("Implantation") &&
          rule.text.includes("hauteur inférieure à 3,5 m") &&
          rule.text.includes("n'est pas règlementée"),
      ),
    ).toBe(true);
    expect(
      result.rules.some(
        (rule) => rule.topic === "height" && rule.text.includes("n'est pas règlementée"),
      ),
    ).toBe(false);
  });

  it("drops an annex exception when its implantation rubrique is absent", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 81,
            text: [
              "ZONE UCa2",
              "- Les constructions à usage d'annexes dont l'emprise au sol est inférieure à 35 m",
              "2 et la hauteur inférieure à 3,5 m n'est pas règlementée.",
            ].join("\n"),
          },
        ],
      }),
    );

    expect(result.rules).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Aucune règle exploitable/iu);
  });

  it("marks an excerpt that exceeds the display limit and adds a warning", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          {
            page: 78,
            text: `ZONE UCa2\nArticle UC3 : l'emprise au sol ne peut excéder ${"x".repeat(1_500)}`,
          },
        ],
      }),
    );

    expect(result.rules.some((rule) => rule.text.includes("[extrait tronqué"))).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/1 200 caractères|page PDF/iu);
  });

  it("exposes an unreadable page and incomplete coverage instead of inventing values", () => {
    const result = extractLandRulesFromPages(
      extractionInput({
        pages: [
          { page: 73, text: "" },
          { page: 74, text: "ZONE UCa2\nArticle UC3 : l'emprise au sol doit être vérifiée." },
        ],
        totalPages: 370,
        coverageComplete: false,
      }),
    );

    expect(result.completeCoverage).toBe(false);
    expect(result.rules).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/sans texte|Extraction partielle/iu);
    expect(result.rules[0]?.text).toContain("emprise au sol doit être vérifiée");
  });

  it("rejects a PDF source outside the official GPU/data.geopf allowlist", () => {
    const result = extractLandRulesFromPages(
      extractionInput({ sourceUrl: "https://example.test/règlement.pdf" }),
    );

    expect(result.rules).toEqual([]);
    expect(result.checks[0]).toMatchObject({ status: "unavailable" });
    expect(result.warnings[0]).toMatch(/allowlist officielle/iu);
  });

  it("does not download an unallowlisted regulation URL", async () => {
    const planning: LandPlanningResult = {
      locationStatus: "references_matched",
      coordinates: null,
      codeInsee: "02191",
      parcels: [],
      zones: [
        {
          id: "zone-1",
          label: "UCa2",
          type: "U",
          description: "Zone test",
          documentId: "doc-1",
          documentName: "PLUi",
          parcelIds: ["parcel-1"],
          regulationUrl: "https://example.test/règlement.pdf",
        },
      ],
      documents: [],
      constraints: [],
      checks: [],
      warnings: [],
      completeCoverage: false,
    };
    const fetcher = async () => {
      throw new Error("fetcher must not be called");
    };

    const result = await fetchLandRules(planning, { fetcher: fetcher as typeof fetch });
    expect(result.rules).toEqual([]);
    expect(result.checks[0]).toMatchObject({ status: "unavailable" });
    expect(result.warnings.join(" ")).toMatch(/allowlist officielle/iu);
  });

  it("follows official HTTP and HTML meta redirects before parsing the PDF", async () => {
    const calls: string[] = [];
    const finalUrl = "https://data.geopf.fr/redirected/reglement.pdf";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.geoportail-urbanisme.gouv.fr/transition" },
        });
      }
      if (calls.length === 2) {
        return new Response(`<meta http-equiv="refresh" content="0; URL='${finalUrl}'">`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("%PDF-1.7\nfixture", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }) as unknown as typeof fetch;

    const result = await fetchLandRules(
      planningForRegulation("https://www.geoportail-urbanisme.gouv.fr/start.pdf"),
      { fetcher },
    );

    expect(calls).toEqual([
      "https://www.geoportail-urbanisme.gouv.fr/start.pdf",
      "https://www.geoportail-urbanisme.gouv.fr/transition",
      finalUrl,
    ]);
    expect(result.checks[0]).toMatchObject({ status: "available", sourceUrl: finalUrl });
  });

  it("refuses a redirect to a host outside the official allowlist", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.invalid/reglement.pdf" },
        }),
    ) as unknown as typeof fetch;

    const result = await fetchLandRules(
      planningForRegulation("https://www.geoportail-urbanisme.gouv.fr/start.pdf"),
      { fetcher },
    );

    expect(result.rules).toEqual([]);
    expect(result.checks[0]).toMatchObject({ status: "unavailable" });
    expect(result.warnings.join(" ")).toMatch(/redirection sort de l'allowlist/iu);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops an official redirect loop after three hops", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const hop = Number(url.pathname.match(/hop(\d+)/)?.[1] ?? "0");
      return new Response(null, {
        status: 302,
        headers: { location: `https://data.geopf.fr/hop${hop + 1}` },
      });
    }) as unknown as typeof fetch;

    const result = await fetchLandRules(
      planningForRegulation("https://www.geoportail-urbanisme.gouv.fr/hop0"),
      { fetcher },
    );

    expect(result.checks[0]).toMatchObject({ status: "unavailable" });
    expect(result.warnings.join(" ")).toMatch(/trop de redirections/iu);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

function planningForRegulation(regulationUrl: string): LandPlanningResult {
  return {
    locationStatus: "references_matched",
    coordinates: null,
    codeInsee: "02191",
    parcels: [],
    zones: [
      {
        id: "zone-1",
        label: "UCa2",
        type: "U",
        description: "Zone test",
        documentId: "doc-1",
        documentName: "PLUi",
        parcelIds: ["parcel-1"],
        regulationUrl,
      },
    ],
    documents: [],
    constraints: [],
    checks: [],
    warnings: [],
    completeCoverage: false,
  };
}
