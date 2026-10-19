import { describe, expect, it } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import { formatPrice } from "@/lib/format";
import { createTextPdf, paginatePdfLines, PDF_PAGE_BREAK } from "@/lib/simple-pdf";
import { buildPlanEntitlements } from "./entitlements";
import {
  FINANCING_DOSSIER_HEADINGS,
  FINANCING_DOSSIER_TITLE,
  FINANCING_NOT_PROVIDED,
  financingDossierLines,
  financingGuaranteeEur,
} from "./financing-dossier";
import { REPORT_PDF_HEADINGS, reportToPdfLines } from "./pdf";
import type { SavedReportRow } from "../property-reports";

type Overrides = {
  sale?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  ceiling?: Record<string, unknown> | null;
};

function report({ sale = {}, analysis = {}, ceiling = null }: Overrides = {}): SavedReportRow {
  return {
    id: "report-financing",
    user_id: "user-financing",
    sale_id: "sale-financing",
    report_kind: "opportunity",
    title: "Rapport de la maison de Pau",
    user_notes: null,
    export_count: 0,
    last_exported_at: null,
    report_snapshot: {
      generatedAt: "2026-10-19T10:00:00.000Z",
      sale: {
        title: "Maison de 92 m² à Pau",
        city: "Pau",
        department: "64",
        displayAddress: "12 rue des Lilas, Pau",
        propertyType: "Maison",
        surface: 92,
        surfaceLabel: "92 m²",
        tribunal: "Tribunal judiciaire de Pau",
        saleDate: "2026-12-10T09:00:00.000Z",
        startingPrice: 92_000,
        venueType: "tribunal",
        ...sale,
      },
      analysis: {
        documentsCount: 3,
        opportunity: { acquisitionCosts: { acquisitionFeesTotal: 14_300, totalCost: 106_300 } },
        auctionCostAnalysis: { consignation: { amountEur: 9_500 } },
        ...analysis,
      },
      sourceTraceability: { entries: [], limitations: [], complianceNotice: "Notice test" },
    } as Json,
    market_snapshot: {} as Json,
    environmental_snapshot: null,
    ceiling_snapshot: (ceiling === null
      ? { available: true, maxBid: 80_000 }
      : ceiling) as unknown as Json,
    share_enabled: false,
    share_token: null,
    share_token_hash: null,
    shared_at: null,
    share_expires_at: null,
    share_view_count: 0,
    created_at: "2026-10-19T10:00:00.000Z",
    updated_at: "2026-10-19T10:00:00.000Z",
  };
}

const plan = buildPlanEntitlements("analyse");

/** Les lignes de la page « Dossier de financement » seule (jusqu'à la fin du rapport). */
function dossierLines(overrides?: Overrides): string[] {
  const lines = reportToPdfLines(report(overrides), plan);
  return lines.slice(lines.indexOf(PDF_PAGE_BREAK) + 1);
}

function valueOf(lines: string[], label: string): string {
  const line = lines.find((item) => item.startsWith(`${label}:`));
  if (!line) throw new Error(`ligne absente : ${label}`);
  return line.slice(label.length + 1).trim();
}

describe("garantie de 10 % (art. R. 322-41 du CPCE)", () => {
  it("suit le tableau de l'article de /ressources : 10 % de la mise à prix, 3 000 € au minimum", () => {
    expect(financingGuaranteeEur(12_000)).toBe(3_000);
    expect(financingGuaranteeEur(30_000)).toBe(3_000);
    expect(financingGuaranteeEur(80_000)).toBe(8_000);
    expect(financingGuaranteeEur(250_000)).toBe(25_000);
  });

  it("n'invente rien sans mise à prix", () => {
    for (const price of [null, undefined, 0, -5, Number.NaN, "92000"]) {
      expect(financingGuaranteeEur(price)).toBeNull();
    }
  });
});

describe("page « Dossier de financement » d'un rapport complet", () => {
  const lines = dossierLines();

  it("est la dernière page du rapport, introduite par un saut de page", () => {
    const all = reportToPdfLines(report(), plan);
    expect(all.filter((line) => line === PDF_PAGE_BREAK)).toHaveLength(1);
    expect(all.indexOf(PDF_PAGE_BREAK)).toBeGreaterThan(all.indexOf("Avertissement"));
    expect(lines[0]).toBe(FINANCING_DOSSIER_TITLE);
  });

  it("reprend la mise à prix, l'enchère plafond et les frais estimés du rapport", () => {
    expect(valueOf(lines, "Mise à prix")).toBe(formatPrice(92_000));
    expect(valueOf(lines, "Enchère plafond (simulation)")).toContain(formatPrice(80_000));
    expect(valueOf(lines, "Enchère plafond (simulation)")).toContain("pas un budget validé");
    expect(valueOf(lines, "Frais estimés hors travaux")).toContain(formatPrice(14_300));
    expect(valueOf(lines, "Frais estimés hors travaux")).toContain("estimation par défaut");
  });

  it("calcule la garantie sur la mise à prix et rappelle le montant de l'annonce", () => {
    expect(
      valueOf(lines, "Garantie de 10 % de la mise à prix, minimum 3 000 € (vente au tribunal)"),
    ).toBe(formatPrice(9_200));
    expect(valueOf(lines, "Montant indiqué dans l’annonce")).toBe(formatPrice(9_500));
  });

  it("met le minimum de 3 000 € quand 10 % ne l'atteignent pas", () => {
    const small = dossierLines({ sale: { startingPrice: 12_000 } });
    expect(
      valueOf(small, "Garantie de 10 % de la mise à prix, minimum 3 000 € (vente au tribunal)"),
    ).toBe(formatPrice(3_000));
  });

  it("donne le délai de paiement, sous peine de réitération des enchères", () => {
    const text = lines.join("\n");
    expect(text).toContain("deux mois après l’adjudication définitive");
    expect(text).toContain("à peine de réitération des enchères (art. R. 322-56)");
    expect(text).toContain("droits de mutation en plus du prix (art. R. 322-58)");
  });

  it("dit ce que les textes ne disent pas plutôt que de le deviner", () => {
    expect(lines.join("\n")).toContain("Imputation de la garantie sur le prix: non précisée");
  });

  it("liste les documents utiles à la banque, dont le nombre de pièces repérées", () => {
    const text = lines.join("\n");
    expect(text).toContain("Documents utiles à la banque");
    expect(text).toContain("cahier des conditions de vente");
    expect(text).toContain("pièces repérées par Immojudis: 3");
    expect(text).toContain("selon votre banque");
    expect(text).toContain("chèque de banque ou caution irrévocable (délai, coût, contrepartie)");
  });

  it("reste prudente : indicative, sans promesse ni prescription", () => {
    const text = lines.join("\n");
    expect(text).toContain(
      "Document indicatif d’Immojudis : ni offre de prêt, ni attestation, ni conseil",
    );
    expect(text).toContain("à vérifier avec votre avocat");
    expect(text.toLowerCase()).not.toMatch(
      /garanti(?!e)|vous obtiendrez|accord assuré|financement acquis/,
    );
  });

  it("annonce la date de génération du rapport", () => {
    expect(lines[1]).toContain("19 octobre 2026");
  });
});

describe("valeurs absentes", () => {
  const empty = dossierLines({
    sale: {
      title: null,
      city: null,
      department: null,
      displayAddress: null,
      address: null,
      propertyType: "Bien",
      surface: null,
      surfaceLabel: "Surface non communiquée",
      tribunal: null,
      saleDate: null,
      startingPrice: null,
      venueType: "tribunal",
    },
    analysis: {
      documentsCount: 0,
      opportunity: { acquisitionCosts: { acquisitionFeesTotal: 0 } },
      auctionCostAnalysis: {},
    },
    ceiling: { available: false, reason: "Données incomplètes", maxBid: null },
  });

  it.each([
    "Localisation",
    "Date de vente",
    "Mise à prix",
    "Enchère plafond (simulation)",
    "Frais estimés hors travaux",
    "Garantie de 10 % de la mise à prix, minimum 3 000 € (vente au tribunal)",
    "Montant indiqué dans l’annonce",
  ])("affiche « non renseigné » pour %s", (label) => {
    expect(valueOf(empty, label)).toBe(FINANCING_NOT_PROVIDED);
  });

  it("affiche « non renseigné » pour le type, la surface et le tribunal", () => {
    expect(valueOf(empty, "Type")).toBe("non renseigné ; surface: non renseigné");
    expect(valueOf(empty, "Type de vente")).toBe("vente au tribunal ; tribunal: non renseigné");
  });

  it("n'affiche jamais 0 €, NaN ni undefined", () => {
    const text = empty.join("\n");
    expect(text).not.toMatch(/\b0 €|NaN|undefined|null/);
  });

  it("annonce zéro pièce comme non renseigné", () => {
    expect(empty.join("\n")).toContain("pièces repérées par Immojudis: non renseigné");
  });

  it("n'annonce pas de frais sans mise à prix, même si le rapport en contient", () => {
    const noPrice = dossierLines({
      sale: { startingPrice: 0 },
      analysis: { opportunity: { acquisitionCosts: { acquisitionFeesTotal: 5_000 } } },
    });
    expect(valueOf(noPrice, "Frais estimés hors travaux")).toBe(FINANCING_NOT_PROVIDED);
  });

  it("n'annonce pas d'enchère plafond qui n'a pas été calculée", () => {
    const uncomputed = dossierLines({ ceiling: { available: true, maxBid: null } });
    expect(valueOf(uncomputed, "Enchère plafond (simulation)")).toBe(FINANCING_NOT_PROVIDED);
  });

  it("tient sur une page même vide", () => {
    const pages = paginatePdfLines(
      [
        PDF_PAGE_BREAK,
        ...financingDossierLines({
          title: "",
          generatedAt: null,
          sale: {},
          ceiling: {},
          acquisitionCosts: {},
          announcedGuarantee: {},
          documentsCount: null,
        }),
      ],
      FINANCING_DOSSIER_HEADINGS,
    );
    expect(pages).toHaveLength(1);
  });
});

describe("autres types de vente", () => {
  it("ne cite pas la garantie de 10 % ni le délai de deux mois comme règle d'une vente chez le notaire", () => {
    const notary = dossierLines({ sale: { venueType: "notary", tribunal: null } });
    const text = notary.join("\n");
    expect(text).toContain("Type de vente: vente chez le notaire");
    expect(text).toContain("ne vise que les ventes au tribunal (vente chez le notaire)");
    expect(text).toContain("à lire dans l’annonce et à demander à l’organisateur");
    expect(text).not.toContain("à peine de réitération des enchères");
    expect(text).not.toContain("R. 322-41");
    expect(valueOf(notary, "Délai")).toContain("fixé par l’annonce ou le cahier des conditions");
    // Les chiffres du dossier, eux, restent ceux du rapport.
    expect(valueOf(notary, "Mise à prix")).toBe(formatPrice(92_000));
  });

  it("signale un type de vente inconnu (rapport antérieur) et applique les règles du tribunal avec cette réserve", () => {
    const old = dossierLines({ sale: { venueType: undefined } });
    expect(valueOf(old, "Type de vente")).toContain(FINANCING_NOT_PROVIDED);
    expect(valueOf(old, "Type de vente")).toContain("vente au tribunal");
    expect(old.join("\n")).toContain("R. 322-41");
  });
});

describe("dans le PDF", () => {
  const pdfPages = () => paginatePdfLines(reportToPdfLines(report(), plan), REPORT_PDF_HEADINGS);

  it("occupe une page à lui seul, la dernière, avec ses intertitres en gras", () => {
    const pages = pdfPages();
    const last = pages[pages.length - 1];
    expect(pages.length).toBeGreaterThan(1);
    expect(last[0]).toEqual({ text: FINANCING_DOSSIER_TITLE, heading: true });
    expect(last.filter((line) => line.heading).map((line) => line.text)).toEqual([
      ...FINANCING_DOSSIER_HEADINGS,
    ]);
    // Rien du reste du rapport sur cette page, et rien de la page sur les précédentes.
    expect(last.some((line) => line.text.startsWith("Avertissement"))).toBe(false);
    expect(
      pages.slice(0, -1).some((page) => page.some((line) => line.text === FINANCING_DOSSIER_TITLE)),
    ).toBe(false);
    expect(last.length).toBeLessThanOrEqual(42);
  });

  it("garde la pagination à jour : n/N sur chaque page, financement compris", () => {
    const pages = pdfPages();
    const text = new TextDecoder().decode(
      createTextPdf({
        title: "Rapport de la maison de Pau",
        lines: reportToPdfLines(report(), plan),
        headings: REPORT_PDF_HEADINGS,
      }),
    );
    expect(text).toContain(`/Count ${pages.length}`);
    for (let page = 1; page <= pages.length; page += 1) {
      expect(text).toContain(`(${page}/${pages.length})`);
    }
    expect(text).not.toContain(`(${pages.length + 1}/`);
  });

  it("écrit les accents et l'euro en WinAnsi", () => {
    const text = new TextDecoder().decode(
      createTextPdf({
        title: "Rapport",
        lines: reportToPdfLines(report(), plan),
        headings: REPORT_PDF_HEADINGS,
      }),
    );
    // « Garantie à remettre avant les enchères », « Synthèse », « € », « l’adjudication ».
    expect(text).toContain("Garantie \\340 remettre avant les ench\\350res");
    expect(text).toContain("Synth\\350se \\340 remettre");
    expect(text).toContain("9 200 \\200");
    expect(text).toContain("l\\222adjudication d\\351finitive");
    expect([...text].every((character) => character.charCodeAt(0) < 128)).toBe(true);
  });
});
