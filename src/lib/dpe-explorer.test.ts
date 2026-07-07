import { describe, expect, it } from "vitest";
import {
  buildDpeExplorerSummary,
  buildDpeMapPoints,
  dpeExplorerQuerySchema,
  type DpeExplorerItem,
} from "./dpe-explorer";

function makeItem(overrides: Partial<DpeExplorerItem> = {}): DpeExplorerItem {
  return {
    id: "7d335032-e935-4550-9347-ed22b0f63449",
    title: "Maison avec DPE",
    city: "Bordeaux",
    department: "33",
    postalCode: "33000",
    address: "Rue exemple",
    propertyType: "house",
    startingPriceEur: 100_000,
    saleDate: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-07-06T09:00:00.000Z",
    dpeClass: "C",
    gesClass: "B",
    dpeLabel: "DPE C",
    dpeSource: "source_blocks",
    diagnosticNumber: null,
    dpeConfidence: null,
    latitude: 44.84,
    longitude: -0.57,
    sourceName: "TJ",
    sourceUrl: "https://example.test",
    ...overrides,
  };
}

describe("dpe explorer", () => {
  it("validates filters and map options", () => {
    expect(
      dpeExplorerQuerySchema.parse({
        department: "33",
        dpeClasses: "A,C,D",
        includeMap: "false",
        limit: "20",
      }),
    ).toMatchObject({
      department: "33",
      dpeClasses: ["A", "C", "D"],
      includeMap: false,
      limit: 20,
    });
  });

  it("builds summaries and map points from DPE items", () => {
    const items = [
      makeItem(),
      makeItem({
        id: "0d335032-e935-4550-9347-ed22b0f63440",
        dpeClass: "F",
        dpeLabel: "DPE F",
        latitude: null,
        longitude: null,
      }),
      makeItem({
        id: "1d335032-e935-4550-9347-ed22b0f63441",
        dpeClass: null,
        gesClass: null,
        dpeLabel: "DPE à lire",
        dpeSource: "documents",
      }),
      makeItem({
        id: "2d335032-e935-4550-9347-ed22b0f63442",
        dpeClass: "E",
        gesClass: "C",
        dpeLabel: "DPE E",
        dpeSource: "ademe",
        diagnosticNumber: "2133E0178774F",
        dpeConfidence: 0.92,
      }),
    ];
    const mapPoints = buildDpeMapPoints(items);

    expect(mapPoints).toHaveLength(3);
    expect(buildDpeExplorerSummary(items, mapPoints)).toMatchObject({
      total: 4,
      knownClassCount: 3,
      documentOnlyCount: 1,
      mapPointCount: 3,
      classCounts: {
        A: 0,
        B: 0,
        C: 1,
        D: 0,
        E: 1,
        F: 1,
        G: 0,
      },
      sourceCounts: {
        ademe: 1,
        sourceBlocks: 2,
        documents: 1,
      },
    });
  });
});
