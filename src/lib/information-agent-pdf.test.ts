import { describe, expect, it } from "vitest";
import { createTextPdf } from "./simple-pdf";
import { assembleImageOnlyPdf, flattenPdfForPublication } from "./information-agent-pdf";

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("PDF flattening before publication (P4-11)", () => {
  it("assembles an image-only PDF without Info dictionary or XMP metadata", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = latin1(assembleImageOnlyPdf([{ jpeg, width: 100, height: 150 }]));

    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Filter /DCTDecode");
    expect(pdf).toContain("/MediaBox [0 0 100 150]");
    expect(pdf).toContain("/Count 1");
    for (const forbidden of ["/Info", "/Author", "/Producer", "/Creator", "/Metadata", "xmp"]) {
      expect(pdf.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("rasterises a real PDF: the text layer and the author metadata do not survive", async () => {
    const source = createTextPdf({
      title: "Procès-verbal confidentiel Jean Dupont",
      lines: ["Nom du locataire : Marie Martin", "Téléphone : 06 12 34 56 78"],
      headings: [],
      footer: "pied de page",
    });
    expect(latin1(source)).toContain("Marie Martin");

    const flattened = await flattenPdfForPublication(source);
    const text = latin1(flattened);

    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("/DCTDecode");
    expect(text).not.toContain("Marie Martin");
    expect(text).not.toContain("06 12 34 56 78");
    expect(text).not.toContain("/Author");
    expect(text).not.toContain("/Info");
    expect(text).not.toContain("/Font");
  }, 60_000);

  it("refuses unreadable input instead of publishing it", async () => {
    await expect(flattenPdfForPublication(new TextEncoder().encode("not a pdf"))).rejects.toThrow(
      "PDF illisible",
    );
  });
});
