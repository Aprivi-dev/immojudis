import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_ROOMS_LABEL,
  DOCUMENT_SURFACE_LABEL,
  documentNoteSentences,
  documentSourceForDisplayedValue,
  withDocumentFactSources,
  type DocumentFactSource,
} from "./document-fact-sources";
import {
  DocumentFactSourcesReadError,
  fetchDocumentFactSources,
  parseDocumentFactSources,
  warnDocumentFactSourcesFailure,
} from "./document-fact-sources-read";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const PIECE_URL = "https://example.test/pieces/cahier des conditions.pdf";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const PIECE_KEY = sha(PIECE_URL);

const source = (
  key: DocumentFactSource["key"],
  overrides: Partial<DocumentFactSource> = {},
): DocumentFactSource => ({
  key,
  documentType: "cahier_conditions_vente",
  documentLabel: "Cahier des conditions",
  page: 12,
  documentKey: PIECE_KEY,
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("lignes de la base", () => {
  it("garde les lignes du contrat, une fois par colonne", () => {
    expect(
      parseDocumentFactSources([
        {
          fact_key: "app_surface_m2",
          document_type: "cahier_conditions_vente",
          page_number: 12,
          document_key: PIECE_KEY,
        },
        { fact_key: "app_surface_m2", document_type: "bail", page_number: 1, document_key: null },
        { fact_key: "rooms_count", document_type: null, page_number: 3, document_key: null },
      ]),
    ).toEqual([
      source("app_surface_m2"),
      source("rooms_count", {
        documentType: null,
        documentLabel: null,
        page: 3,
        documentKey: null,
      }),
    ]);
  });

  it("écarte une colonne hors liste, une page absente, et neutralise un type hors forme", () => {
    expect(
      parseDocumentFactSources([
        { fact_key: "starting_price_eur", document_type: "bail", page_number: 1 },
        { fact_key: "habitable_surface_m2", document_type: "bail", page_number: 1 },
        { fact_key: "land_surface_m2", document_type: "bail", page_number: 0 },
        { fact_key: "land_surface_m2", document_type: "bail", page_number: "2" },
        {
          fact_key: "rooms_count",
          document_type: "Pièce de M. Dupont",
          page_number: 2,
          document_key: null,
        },
      ]),
    ).toEqual([
      source("rooms_count", {
        documentType: null,
        documentLabel: null,
        page: 2,
        documentKey: null,
      }),
    ]);
    expect(parseDocumentFactSources(null)).toEqual([]);
    expect(parseDocumentFactSources({ fact_key: "rooms_count" })).toEqual([]);
  });
});

describe("lecture", () => {
  it("lit la RPC publique de la vente", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { fact_key: "rooms_count", document_type: "bail", page_number: 2, document_key: null },
      ],
      error: null,
    });
    await expect(fetchDocumentFactSources({ rpc }, ID)).resolves.toEqual([
      source("rooms_count", {
        documentType: "bail",
        documentLabel: "Bail / occupation",
        page: 2,
        documentKey: null,
      }),
    ]);
    expect(rpc).toHaveBeenCalledWith("get_public_sale_document_fact_sources", { p_sale_id: ID });
  });

  it("lève une erreur avec son code seul, jamais « aucune mention »", async () => {
    const failing = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "57014" } }) };
    await expect(fetchDocumentFactSources(failing, ID)).rejects.toEqual(
      new DocumentFactSourcesReadError("57014"),
    );
    const offline = { rpc: vi.fn().mockRejectedValue(new Error("fetch failed")) };
    await expect(fetchDocumentFactSources(offline, ID)).rejects.toMatchObject({ code: "network" });
  });

  it("trace une lecture en échec avec son code seul", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnDocumentFactSourcesFailure(new DocumentFactSourcesReadError("57014"));
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      scope: "public-sale-document-fact-sources",
      level: "warn",
      event: "rpc_failed",
      code: "57014",
    });
  });

  it("ne change pas la vente sans source", () => {
    const sale = { id: ID };
    expect(withDocumentFactSources(sale, [])).toBe(sale);
    expect(withDocumentFactSources(sale, [source("rooms_count")])).toEqual({
      id: ID,
      document_fact_sources: [source("rooms_count")],
    });
  });
});

describe("valeur affichée", () => {
  const sale = {
    app_surface_m2: 62.4,
    land_surface_m2: 500,
    rooms_count: 3,
    document_fact_sources: [source("app_surface_m2"), source("rooms_count")],
  };

  it("attribue la surface affichée et le nombre de pièces à leur pièce", () => {
    expect(documentSourceForDisplayedValue(sale, "surface")).toEqual(source("app_surface_m2"));
    expect(documentSourceForDisplayedValue(sale, "rooms_count")).toEqual(source("rooms_count"));
  });

  it("ne dit rien pour une valeur masquée, absente ou d'une autre origine", () => {
    expect(documentSourceForDisplayedValue(sale, "surface", { blocked: true })).toBeNull();
    expect(documentSourceForDisplayedValue(sale, "surface", { surface: 70 })).toBeNull();
    expect(documentSourceForDisplayedValue({ ...sale, rooms_count: 0 }, "rooms_count")).toBeNull();
    expect(
      documentSourceForDisplayedValue({ ...sale, document_fact_sources: [] }, "surface"),
    ).toBeNull();
  });

  it("attribue la surface d'une vente « terrain seul » au terrain lu", () => {
    const land = {
      app_surface_m2: 500,
      land_surface_m2: 500,
      document_fact_sources: [source("land_surface_m2", { page: 4 })],
    };
    expect(documentSourceForDisplayedValue(land, "surface")).toEqual(
      source("land_surface_m2", { page: 4 }),
    );
  });
});

describe("texte de la mention", () => {
  it("nomme la valeur, la pièce par le libellé de la liste des pièces, et la page, avec l'accord", () => {
    expect(
      documentNoteSentences([{ label: DOCUMENT_SURFACE_LABEL, source: source("app_surface_m2") }]),
    ).toEqual([
      {
        lead: "Surface relevée automatiquement dans",
        piece: "la pièce « Cahier des conditions », page 12",
        page: 12,
        documentKey: PIECE_KEY,
      },
    ]);
    const [rooms] = documentNoteSentences([
      {
        label: DOCUMENT_ROOMS_LABEL,
        source: source("rooms_count", { documentType: null, documentLabel: null, page: 3 }),
      },
    ]);
    expect(`${rooms.lead} ${rooms.piece}`).toBe(
      "Nombre de pièces relevé automatiquement dans une pièce du dossier, page 3",
    );
  });

  it("réunit les valeurs d'une même page en une phrase, et sépare les autres", () => {
    const together = documentNoteSentences([
      { label: DOCUMENT_SURFACE_LABEL, source: source("app_surface_m2") },
      { label: DOCUMENT_ROOMS_LABEL, source: source("rooms_count") },
    ]);
    expect(together.map((sentence) => sentence.lead)).toEqual([
      "Surface et nombre de pièces relevés automatiquement dans",
    ]);
    const apart = documentNoteSentences([
      { label: DOCUMENT_SURFACE_LABEL, source: source("app_surface_m2") },
      { label: DOCUMENT_ROOMS_LABEL, source: source("rooms_count", { page: 13 }) },
      { label: DOCUMENT_ROOMS_LABEL, source: null },
    ]);
    expect(apart.map((sentence) => `${sentence.lead} ${sentence.piece}`)).toEqual([
      "Surface relevée automatiquement dans la pièce « Cahier des conditions », page 12",
      "Nombre de pièces relevé automatiquement dans la pièce « Cahier des conditions », page 13",
    ]);
    expect(documentNoteSentences([{ label: DOCUMENT_SURFACE_LABEL, source: null }])).toEqual([]);
  });
});
