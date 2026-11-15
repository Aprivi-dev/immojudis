import { describe, expect, it, vi } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime-open";
import type { AuctionSale } from "@/lib/types";
import type { SavedReportRow } from "../property-reports";
import { createTextPdf } from "../simple-pdf";
import { buildCeilingSnapshot } from "./ceiling-snapshot";
import { buildPlanEntitlements } from "./entitlements";
import { REPORT_PDF_HEADINGS, reportToPdfLines } from "./pdf";

vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: vi.fn() }));

const { buildReportSnapshot } = await import("./analysis");

const NOTE =
  "Surface provisoire de 20 m² retenue pour les calculs : l'annonce ne publie pas la surface.";
const plan = buildPlanEntitlements("analyse");
const studio = {
  ...EXAMPLE_SALE,
  title: "Studio",
  property_type: "studio",
  app_surface_m2: null,
  habitable_surface_m2: null,
  carrez_surface_m2: null,
  rooms_count: null,
} as AuctionSale;
const measured = { ...studio, app_surface_m2: 18 } as AuctionSale;

/** Le rapport tel qu'il est enregistré : instantanés relus après un aller-retour JSON. */
function savedReport(sale: AuctionSale): SavedReportRow {
  const ceiling = buildCeilingSnapshot(sale, null, {}, DEFAULT_OPEN_FEE_REGIMES);
  const snapshot = buildReportSnapshot({
    sale,
    marketEstimate: EXAMPLE_MARKET_ESTIMATE,
    activeComparables: { scopeLabel: "", sales: [] },
    cadastreParcels: [],
    dpeDiagnostics: [],
    urbanPlanningSignals: [],
    valuationBacktest: null,
    ceilingSnapshot: ceiling,
    plan,
  });
  return {
    id: "report-studio",
    user_id: "user-1",
    sale_id: sale.id,
    report_kind: "opportunity",
    title: "Rapport studio",
    user_notes: null,
    export_count: 0,
    last_exported_at: null,
    report_snapshot: JSON.parse(JSON.stringify(snapshot)) as Json,
    market_snapshot: {} as Json,
    environmental_snapshot: null,
    ceiling_snapshot: JSON.parse(JSON.stringify(ceiling)) as Json,
    share_enabled: false,
    share_token: null,
    share_token_hash: null,
    shared_at: null,
    share_expires_at: null,
    share_view_count: 0,
    created_at: "2026-11-15T10:00:00.000Z",
    updated_at: "2026-11-15T10:00:00.000Z",
  };
}

/** Le texte écrit dans le PDF (opérateurs `Tj`), décodé du WinAnsi, une ligne affichée après l'autre. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  return [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map(([, text]) =>
      text.replace(/\\([0-7]{3}|.)/g, (_, code: string) =>
        code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : code,
      ),
    )
    .join(" ");
}

describe("rapport calculé sur une surface présumée", () => {
  it("garde la nature de la surface dans l'instantané", () => {
    expect(asSale(savedReport(studio))).toMatchObject({ surface: 20, surfaceKind: "estimated" });
    expect(asSale(savedReport(measured))).toMatchObject({ surface: 18, surfaceKind: "recorded" });
  });

  it("le PDF le dit en tête de la lecture d'opportunité, avant la valeur, l'écart et le rendement", () => {
    const lines = reportToPdfLines(savedReport(studio), plan);
    const heading = lines.indexOf("Lecture opportunité");
    expect(lines[heading + 1]).toBe(NOTE);
    expect(lines.findIndex((line) => line.startsWith("Valeur médiane estimée"))).toBeGreaterThan(
      heading + 1,
    );

    const text = pdfText(
      createTextPdf({ title: "Rapport studio", lines, headings: REPORT_PDF_HEADINGS }),
    );
    expect(text).toContain(NOTE);
  });

  it("aucune mention pour une surface mesurée", () => {
    const lines = reportToPdfLines(savedReport(measured), plan);
    expect(lines.join("\n")).not.toContain("Surface provisoire");
    expect(
      pdfText(createTextPdf({ title: "Rapport", lines, headings: REPORT_PDF_HEADINGS })),
    ).not.toContain("Surface provisoire");
  });
});

function asSale(report: SavedReportRow): unknown {
  return (report.report_snapshot as { sale: unknown }).sale;
}
