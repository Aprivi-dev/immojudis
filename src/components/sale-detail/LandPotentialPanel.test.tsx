// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLandProjectAnalyses } from "@/lib/land-project-analysis";
import { extractLandRulesFromPages } from "@/lib/land-rule-extraction";
import type {
  LandPlanningResult,
  LandReport,
  LandRisksResult,
  LandRulesResult,
  LandSourceCheck,
  LandSourceStatus,
} from "@/lib/land-report-types";
import { LandPotentialPanel } from "./LandPotentialPanel";

const mocks = vi.hoisted(() => ({
  fetchReport: vi.fn(),
  downloadReport: vi.fn(),
}));

vi.mock("@/lib/land-report-client", () => ({
  fetchSaleLandReport: mocks.fetchReport,
  downloadSaleLandReport: mocks.downloadReport,
}));

vi.mock("./LandParcelDiagram", () => ({
  LandParcelDiagram: () => <div data-testid="land-parcel-diagram" />,
}));

const SOURCE_URL = "https://data.geopf.fr/annexes/gpu/saint-quentin-reglement.pdf";
const SALE_ID = "sale-land-17-roland-garros";

function sourceCheck(key: string, status: LandSourceStatus, message = ""): LandSourceCheck {
  return {
    key,
    label: key === "rules" ? "Règlement PLU" : "Cadastre et zonage",
    status,
    scope: "document",
    sourceUrl: SOURCE_URL,
    checkedAt: "2026-10-02T12:00:00.000Z",
    message: message || undefined,
    version: "200071892_PLUi_20260520",
  };
}

const planning: LandPlanningResult = {
  locationStatus: "references_matched",
  coordinates: { longitude: 3.287, latitude: 49.84 },
  codeInsee: "02691",
  parcels: [
    {
      id: "02691000CT0190",
      codeInsee: "02691",
      section: "CT",
      number: "0190",
      prefix: "000",
      city: "Saint-Quentin",
      surfaceM2: 698,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [3.286, 49.84],
            [3.287, 49.84],
            [3.287, 49.841],
            [3.286, 49.841],
            [3.286, 49.84],
          ],
        ],
      },
      match: "document_reference",
      sourceUrl: "https://cadastre.data.gouv.fr/",
    },
  ],
  zones: [
    {
      id: "zone-uca2",
      label: "UCa2",
      description: "Zone urbaine identifiée par intersection du contour cadastral.",
      type: "U",
      documentId: "plui-saint-quentin",
      documentName: "PLUi de Saint-Quentin · règlement",
      parcelIds: ["02691000CT0190"],
      regulationUrl: SOURCE_URL,
      startPage: 73,
    },
  ],
  documents: [
    {
      id: "plui-saint-quentin",
      name: "200071892_reglement_20260520.pdf",
      type: "PLUi",
      title: "PLUi de Saint-Quentin",
      legalStatus: "APPROVED",
      effectiveStatus: "En vigueur",
      publicationDate: "2026-06-18",
      updatedAt: "2026-06-18",
      sourceUrl: "https://www.geoportail-urbanisme.gouv.fr/document/by-id/plui-saint-quentin",
      files: [{ name: "Règlement", url: SOURCE_URL }],
      downloadable: true,
    },
  ],
  constraints: [
    {
      id: "sup-pm1",
      kind: "servitude",
      label: "PM1 · PPR inondations",
      typeCode: "PM1",
      layer: "SUP",
      parcelIds: ["02691000CT0190"],
      documentId: "ppr-somme",
      detail: "Enveloppe des zonages réglementaires.",
      isEnvelope: true,
    },
  ],
  checks: [sourceCheck("planning", "available")],
  warnings: [],
  completeCoverage: true,
};

const risks: LandRisksResult = {
  findings: [],
  checks: [sourceCheck("risks", "not_checked", "Synthèse ponctuelle indisponible dans ce test.")],
  warnings: ["La synthèse ponctuelle n'établit pas l'absence de risque."],
};

const extractedRules = extractLandRulesFromPages({
  documentId: "plui-saint-quentin",
  documentName: "200071892_reglement_20260520.pdf",
  sourceUrl: SOURCE_URL,
  targetZoneLabels: ["UCa2"],
  pages: [
    {
      page: 77,
      text: [
        "Article UC3 : Volumétrie et implantation des constructions",
        "3.1.2 Disposition générale - L'emprise au sol maximale des constructions ne peut excéder 60% de la surface du terrain.",
        "3.2.1 Dispositions générales - Dans les secteurs UC1 et UC2 : hauteur 9 mètres. Dans les secteurs UCa1 et UCa2 : la hauteur maximale peut atteindre R+4 sous réserve des conditions du règlement.",
      ].join("\n"),
    },
    {
      page: 78,
      text: [
        "3.3.3.2 Dispositions applicables aux zones UC2, UCa2 et UCb2.",
        "Les extensions et annexes sont encadrées par les conditions de l'article.",
      ].join("\n"),
    },
    {
      page: 80,
      text: "Dispositions applicables au secteur UCb2 : la hauteur maximale est limitée à R+1.",
    },
    {
      page: 86,
      text: "Stationnement des constructions en zone UCa2 : les conditions de stationnement sont celles de l'article.",
    },
  ],
  totalPages: 370,
  coverageComplete: false,
  checkedAt: "2026-10-02T12:00:00.000Z",
  version: "200071892_PLUi_20260520",
});

function makeReport(overrides: Partial<LandRulesResult> = {}): LandReport {
  const rules: LandRulesResult = {
    ...extractedRules,
    ...overrides,
    rules: overrides.rules ?? extractedRules.rules,
    checks: overrides.checks ?? [sourceCheck("rules", "partial")],
    warnings: overrides.warnings ?? extractedRules.warnings,
  };
  const report: Omit<LandReport, "projects"> = {
    version: "land-report-v1",
    generatedAt: "2026-10-02T12:00:00.000Z",
    planning,
    risks,
    rules,
  };
  return { ...report, projects: buildLandProjectAnalyses(report) };
}

function renderPanel(props: Partial<React.ComponentProps<typeof LandPotentialPanel>> = {}) {
  return render(
    <LandPotentialPanel saleId={SALE_ID} enabled initialReport={makeReport()} {...props} />,
  );
}

describe("LandPotentialPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchReport.mockResolvedValue(makeReport());
    mocks.downloadReport.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("affiche les preuves des pages 77–86 sans attribuer la règle UCb2 à UCa2", () => {
    expect(extractedRules.rules.every((rule) => !rule.text.includes("secteur UCb2"))).toBe(true);
    expect(
      extractedRules.rules.some(
        (rule) => rule.text.includes("UCa1") && rule.zoneLabels.includes("UCa2"),
      ),
    ).toBe(true);

    renderPanel();

    expect(screen.getAllByText(/60%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/sous réserve des conditions du règlement/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("Page PDF 77").length).toBeGreaterThan(0);
    expect(screen.queryByText(/secteur UCb2/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Votre projet"), { target: { value: "height" } });
    expect(screen.getAllByText(/UCa1 et UCa2/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ne vaut ni droit disponible ni autorisation/)).toBeTruthy();
  });

  it("confronte la zone citée et la surface annoncée au rapport officiel", () => {
    renderPanel({ listingZone: "UCa2*L12", landSurfaceM2: 4_000 });
    expect(
      screen.getByText(/Zone citée dans l’annonce : UCa2\*L12 · concorde avec le zonage officiel/),
    ).toBeTruthy();
    expect(screen.getByText(/couvre 698 m² alors que l’annonce indique 4 000 m²/)).toBeTruthy();
    cleanup();
    renderPanel({ listingZone: "UB", landSurfaceM2: 700 });
    expect(screen.getByText(/diffère du zonage officiel/)).toBeTruthy();
    expect(screen.queryByText(/alors que l’annonce indique/)).toBeNull();
  });

  it("rend la couverture partielle et les limites des sources dans le panneau", () => {
    renderPanel();

    fireEvent.click(screen.getByText("Sources, dates et limites"));

    expect(screen.getByText(/Vérification partielle/)).toBeTruthy();
    expect(screen.getByText(/Extraction partielle/)).toBeTruthy();
    expect(screen.getByText(/Aucun constat exploitable/)).toBeTruthy();
    expect(screen.getByText(/enveloppe repérée/i)).toBeTruthy();
  });

  it("distingue une source indisponible d'une couche vide", () => {
    const unavailable = makeReport({
      rules: [],
      checks: [sourceCheck("rules", "unavailable", "Le règlement n'a pas pu être consulté.")],
      warnings: ["La lecture du règlement n'a pas pu aboutir."],
      completeCoverage: false,
    });
    const { unmount } = renderPanel({ initialReport: unavailable });
    expect(screen.getByText(/1 source indisponible/)).toBeTruthy();
    fireEvent.click(screen.getByText("Sources, dates et limites"));
    expect(screen.getByText(/Source indisponible/)).toBeTruthy();
    expect(screen.getByText("Le règlement n'a pas pu être consulté.")).toBeTruthy();
    unmount();

    const empty = makeReport({
      rules: [],
      checks: [
        sourceCheck("rules", "empty", "La couche consultée ne contient aucun enregistrement."),
      ],
      warnings: [],
      completeCoverage: false,
    });
    renderPanel({ initialReport: empty });
    expect(screen.queryByText(/source indisponible/iu)).toBeNull();
    fireEvent.click(screen.getByText("Sources, dates et limites"));
    expect(screen.getByText(/Aucun enregistrement dans cette couche/)).toBeTruthy();
    expect(screen.getByText(/Aucun article de la zone n’a pu être extrait/)).toBeTruthy();
    expect(screen.queryByLabelText("Votre projet")).toBeNull();
  });

  it("ne propose que les projets éclairés par un article lu", () => {
    renderPanel();

    const select = screen.getByLabelText("Votre projet") as HTMLSelectElement;
    const offered = [...select.options].map((option) => option.value);
    expect(offered.length).toBeGreaterThan(0);
    expect(screen.queryByText(/informations insuffisantes/)).toBeNull();
    fireEvent.change(select, { target: { value: offered.at(-1) } });
    expect(select.value).toBe(offered.at(-1));
    fireEvent.click(screen.getByText("Points à vérifier avant ce projet"));
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("dit d’abord d’où vient la parcelle", () => {
    renderPanel();
    expect(
      screen.getByText("Parcelle identifiée par une référence cadastrale du dossier."),
    ).toBeTruthy();
  });

  it("lit le rapport sans attendre de clic et propose de réessayer en cas d’échec", async () => {
    mocks.fetchReport.mockRejectedValueOnce(new Error("Service PLU temporairement indisponible"));
    render(<LandPotentialPanel saleId={SALE_ID} enabled />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Service PLU temporairement indisponible",
    );
    expect(mocks.fetchReport).toHaveBeenCalledTimes(1);
    expect(mocks.fetchReport).toHaveBeenCalledWith(SALE_ID, false);
    expect(screen.queryByText(/Aucun enregistrement dans cette couche/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(
      await screen.findByText("Parcelle identifiée par une référence cadastrale du dossier."),
    ).toBeTruthy();
    expect(mocks.fetchReport).toHaveBeenCalledTimes(2);
  });

  it("partage le rapport avec le plan cadastral", async () => {
    const onReport = vi.fn();
    render(<LandPotentialPanel saleId={SALE_ID} enabled onReport={onReport} />);
    await waitFor(() =>
      expect(onReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ planning: expect.anything() }),
      ),
    );
  });

  it("déclenche l'export du dossier pour un membre premium", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Exporter le dossier PDF" }));
    await waitFor(() => expect(mocks.downloadReport).toHaveBeenCalledWith(SALE_ID));
  });

  it("affiche l'upsell sans appeler les sources lorsque le panneau est verrouillé", () => {
    render(<LandPotentialPanel saleId={SALE_ID} enabled={false} />);

    expect(screen.getByText(/L’offre Analyse donne accès/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Découvrir l’offre Analyse/ }).getAttribute("href"),
    ).toBe("/offres");
    expect(screen.queryByRole("button", { name: /Consulter le PLU/ })).toBeNull();
    expect(mocks.fetchReport).not.toHaveBeenCalled();
  });
});
