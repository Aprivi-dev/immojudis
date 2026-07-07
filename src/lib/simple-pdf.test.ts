import { describe, expect, it } from "vitest";
import { createTextPdf } from "@/lib/simple-pdf";

describe("createTextPdf", () => {
  it("embeds a sanitized watermark when provided", () => {
    const pdf = createTextPdf({
      title: "Rapport test",
      lines: ["Ligne de rapport"],
      watermark: "VERSION DÉCOUVERTE — EXTRAIT LIMITÉ",
    });

    const text = new TextDecoder().decode(pdf);

    expect(text).toContain("%PDF-1.4");
    expect(text).toContain("VERSION DECOUVERTE - EXTRAIT LIMITE");
    expect(text).toContain("0.707 0.707 -0.707 0.707");
  });
});
