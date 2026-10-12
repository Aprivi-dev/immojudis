import { describe, expect, it } from "vitest";
import {
  documentPageHref,
  documentReadingTeaser,
  groupReadingPoints,
  mapDocumentReading,
} from "./document-reading";

const raw = {
  status: "completed",
  generated_at: "2026-10-12T08:00:00Z",
  input_truncated: true,
  documents: [
    {
      index: 1,
      label: "PV de description",
      url: "https://example.test/pv.pdf",
      document_type: "pv_huissier",
    },
    {
      index: 2,
      label: "CCV",
      url: "javascript:alert(1)",
      document_type: "cahier_conditions_vente",
    },
  ],
  points: [
    {
      theme: "occupation",
      importance: "alerte",
      title: "Bien occupé sans bail",
      explanation: "Une procédure d'expulsion sera nécessaire.",
      quote: "occupé par Monsieur X",
      document_index: 1,
      page: 2,
    },
    {
      theme: "conditions_vente",
      importance: "info",
      title: "Consignation",
      quote: "10 % de la mise à prix",
      document_index: 2,
      page: 7,
    },
    {
      theme: "occupation",
      importance: "weird",
      title: "Clés",
      quote: "remise des clés",
      document_index: 1,
      page: 3,
    },
    { theme: "diagnostics", title: "Sans citation", document_index: 1, page: 1 },
  ],
};

describe("document reading", () => {
  it("maps verified points with their document and drops unsafe links", () => {
    const reading = mapDocumentReading(raw);
    expect(reading.status).toBe("completed");
    expect(reading.partial).toBe(true);
    expect(reading.points).toHaveLength(3);
    expect(reading.points[0].document).toEqual({
      label: "PV de description",
      url: "https://example.test/pv.pdf",
      documentType: "pv_huissier",
    });
    expect(reading.points[1].document?.url).toBeNull();
    expect(reading.points[2].importance).toBe("info");
  });

  it("reports a missing reading as pending", () => {
    expect(mapDocumentReading(null)).toMatchObject({ status: "pending", points: [] });
  });

  it("tells a free account how much was found, never what", () => {
    const teaser = documentReadingTeaser(mapDocumentReading(raw));
    expect(teaser).toEqual({
      access: "teaser",
      pointCount: 3,
      alertCount: 1,
      themes: ["occupation", "conditions_vente"],
    });
    expect(JSON.stringify(teaser)).not.toMatch(/Monsieur|mise à prix|pv\.pdf/);
  });

  it("links to the cited page of a PDF and groups points by theme", () => {
    expect(documentPageHref("https://example.test/pv.pdf", 4)).toBe(
      "https://example.test/pv.pdf#page=4",
    );
    expect(documentPageHref("https://example.test/annonce", 1)).toBe(
      "https://example.test/annonce",
    );
    expect(documentPageHref(null, 1)).toBeNull();
    const groups = groupReadingPoints(mapDocumentReading(raw).points);
    expect(groups.map((group) => [group.theme, group.points.length])).toEqual([
      ["occupation", 2],
      ["conditions_vente", 1],
    ]);
  });
});
