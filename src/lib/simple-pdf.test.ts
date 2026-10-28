import { describe, expect, it } from "vitest";
import { createTextPdf, paginatePdfLines, PDF_PAGE_BREAK, textWidthPt } from "@/lib/simple-pdf";

describe("createTextPdf", () => {
  it("moves a heading with its following paragraph instead of leaving it at the page foot", () => {
    const paragraph = "- " + "Une action à vérifier dans les pièces. ".repeat(5);
    const pages = paginatePdfLines(
      [...Array.from({ length: 41 }, (_, i) => `Repère ${i}`), "Actions", paragraph],
      ["Actions"],
    );
    expect(pages[0]).toHaveLength(41);
    expect(pages[1][0]).toEqual({ text: "Actions", heading: true });
    expect(
      pages[1]
        .slice(1)
        .map((line) => line.text)
        .join(" "),
    ).toContain("Une action à vérifier");
    expect(pages).toHaveLength(2);
  });

  it("starts a fresh page at a page break, without a blank page for a leading or repeated break", () => {
    const pages = paginatePdfLines(
      [
        PDF_PAGE_BREAK,
        "Début",
        "Suite",
        PDF_PAGE_BREAK,
        PDF_PAGE_BREAK,
        "Résumé",
        "Une ligne",
        PDF_PAGE_BREAK,
      ],
      ["Résumé"],
    );
    expect(pages.map((page) => page.map((line) => line.text))).toEqual([
      ["Début", "Suite"],
      ["Résumé", "Une ligne"],
    ]);
    // Un intertitre en tête de page neuve n'est pas précédé d'une ligne blanche.
    expect(pages[1][0]).toEqual({ text: "Résumé", heading: true });
  });

  it("numbers the pages after a page break", () => {
    const text = new TextDecoder().decode(
      createTextPdf({ title: "Rapport", lines: ["Page un", PDF_PAGE_BREAK, "Page deux"] }),
    );
    expect(text).toContain("/Count 2");
    expect(text).toContain("(1/2)");
    expect(text).toContain("(2/2)");
  });

  it("keeps a wrapped bullet together when it fits on a fresh page", () => {
    const pages = paginatePdfLines([
      ...Array.from({ length: 41 }, () => "Repère"),
      "- " + "Document à relire. ".repeat(12),
    ]);
    expect(pages[0]).toHaveLength(41);
    expect(pages[1][0].text).toMatch(/^- /);
    expect(pages[1].length).toBeGreaterThan(1);
  });

  it("splits oversized paragraphs without dropping text or exceeding page capacity", () => {
    const source = "Une ligne longue. ".repeat(500);
    const pages = paginatePdfLines(["Actions", source], ["Actions"]);
    expect(pages[0][0].heading).toBe(true);
    expect(pages[0].length).toBeGreaterThan(1);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 42)).toBe(true);
    expect(
      pages
        .flat()
        .filter((line) => !line.heading)
        .map((line) => line.text)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(source.replace(/\s/g, ""));
  });

  it("encodes French characters and units as WinAnsi without corrupting PDF offsets", () => {
    const text = new TextDecoder().decode(
      createTextPdf({
        title: "Évry — 58 m²",
        lines: ["3 022 €/m² ; volume 140 m³", "Œuvre à vérifier : e\u0301tage"],
      }),
    );
    expect(text).toContain("/Encoding /WinAnsiEncoding");
    expect(text).toContain("\\311vry \\227 58 m\\262");
    expect(text).toContain("3 022 \\200/m\\262 ; volume 140 m\\263");
    expect(text).toContain("\\214uvre \\340 v\\351rifier : \\351tage");
    expect([...text].every((character) => character.charCodeAt(0) < 128)).toBe(true);
    const xref = Number(text.match(/startxref\n(\d+)/)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
  });
  it("writes ≤ and ≥ in words instead of dropping them", () => {
    const lines = paginatePdfLines(["Hauteur ≤ 9 m, recul ≥ 3 m", "Emprise ≤60 %"]);
    expect(lines[0].map((line) => line.text)).toEqual([
      "Hauteur au plus 9 m, recul au moins 3 m",
      "Emprise au plus 60 %",
    ]);
  });

  describe("geometry", () => {
    const widest = (pages: ReturnType<typeof paginatePdfLines>) =>
      Math.max(...pages.flat().map((line) => textWidthPt(line.text, 10, line.heading)));

    it("measures Helvetica text (AFM widths)", () => {
      // H 722 + e 556 + l 222 + l 222 + o 556 = 2 278 millièmes de corps.
      expect(textWidthPt("Hello", 10, false)).toBeCloseTo(22.78, 5);
      // Helvetica-Bold : H 722 + e 556 + l 278 + l 278 + o 611 = 2 445.
      expect(textWidthPt("Hello", 10, true)).toBeCloseTo(24.45, 5);
      expect(textWidthPt("é", 10, false)).toBeCloseTo(5.56, 5);
    });

    it.each([
      ["capitals", "W".repeat(92)],
      ["digits", "0123456789".repeat(12)],
      ["url", "https://www.exemple.fr/" + "a-très-long-chemin/".repeat(10)],
      ["words", "MAÎTRE DUPONT-MARTIN AVOCAT AU BARREAU DE PARIS ".repeat(8)],
    ])("keeps %s inside the 495 pt text width", (_name, text) => {
      const pages = paginatePdfLines([text, text.toLowerCase()]);
      expect(widest(pages)).toBeLessThanOrEqual(495);
      expect(
        pages
          .flat()
          .map((line) => line.text)
          .join("")
          .replace(/\s/g, ""),
      ).toBe((text + text.toLowerCase()).replace(/\s/g, ""));
    });

    it("measures bold headings with the bold widths", () => {
      const heading = "ÉVALUATION DE LA SITUATION OCCUPATIONNELLE DU BIEN ".repeat(4).trim();
      expect(widest(paginatePdfLines([heading], [heading]))).toBeLessThanOrEqual(495);
    });

    it("never splits an amount from its unit across two lines", () => {
      const lead = "Montant de la première offre possible enregistrée dans le rapport :";
      for (let pad = 0; pad < 40; pad += 1) {
        const line = `${"x".repeat(pad)} ${lead} ${(1_234_567).toLocaleString("fr-FR")}\u202F€ fin`;
        const lines = paginatePdfLines([line]).flat();
        const amount = lines.find((entry) => entry.text.includes("567"));
        expect(amount?.text, `pad ${pad}`).toMatch(/567\u00A0€/);
      }
    });

    it("writes thin and no-break spaces as U+00A0 (0xA0) in the PDF", () => {
      const text = new TextDecoder().decode(
        createTextPdf({ title: "Rapport", lines: ["Plafond : 123\u202F456\u00A0€"] }),
      );
      expect(text).toContain("123\\240456\\240\\200");
    });

    it("replaces ≠ ≈ → and the non-breaking hyphen instead of dropping them", () => {
      const lines = paginatePdfLines(["A ≠ B, C ≈ D, E → F, 12\u201134"]);
      expect(lines[0][0].text).toBe("A différent de B, C environ D, E vers F, 12-34");
    });

    it("puts a long title on two lines, or truncates it with an ellipsis", () => {
      const content = (pdf: string) => pdf.split("BT")[1].split("/F1 10 Tf")[0];
      const two = new TextDecoder().decode(
        createTextPdf({
          title:
            "Rapport d'analyse - Appartement de 3 pièces avec cave et parking, rue des Tilleuls à Lyon",
          lines: ["Ligne"],
        }),
      );
      expect(content(two)).toContain("0 -18 Td");
      expect(content(two).match(/ Tj/g)).toHaveLength(2);
      const long = new TextDecoder().decode(
        createTextPdf({ title: "MOT ".repeat(60), lines: ["Ligne"] }),
      );
      expect(content(long).match(/ Tj/g)).toHaveLength(2);
      expect(content(long)).toContain("\\205)"); // « … »
    });

    it("keeps a long footer clear of the page number", () => {
      const text = new TextDecoder().decode(
        createTextPdf({
          title: "Rapport",
          lines: ["Ligne"],
          footer: "Mention de pied de page très longue. ".repeat(6),
        }),
      );
      expect(text).toContain("0 -10 Td");
      expect(text).toContain("420 10 Td");
    });
  });

  describe("metadata", () => {
    it("declares the title and the language, and stays deterministic", () => {
      const make = () =>
        new TextDecoder().decode(createTextPdf({ title: "Rapport — Évry", lines: ["Ligne"] }));
      const pdf = make();
      expect(pdf).toContain("/Lang (fr-FR)");
      expect(pdf).toMatch(/trailer\n<< \/Size \d+ \/Root 1 0 R \/Info \d+ 0 R >>/);
      // « Rapport — Évry » en UTF-16BE avec BOM : R a p p o r t, espace, U+2014, espace, É v r y.
      expect(pdf).toContain(
        "/Title <FEFF" +
          "0052" +
          "0061" +
          "0070" +
          "0070" +
          "006F" +
          "0072" +
          "0074" +
          "0020" +
          "2014" +
          "0020" +
          "00C9" +
          "0076" +
          "0072" +
          "0079>",
      );
      expect(pdf).not.toContain("/CreationDate");
      expect(make()).toBe(pdf);
    });

    it("keeps the cross-reference table valid with the Info object", () => {
      const text = new TextDecoder().decode(createTextPdf({ title: "Rapport", lines: ["Ligne"] }));
      const count = Number(text.match(/xref\n0 (\d+)/)?.[1]);
      expect(text).toContain(`/Size ${count}`);
      expect(text.match(/\d+ 0 obj/g)).toHaveLength(count - 1);
    });
  });

  it("embeds a sanitized watermark when provided", () => {
    const pdf = createTextPdf({
      title: "Rapport test",
      lines: ["Ligne de rapport"],
      watermark: "VERSION DÉCOUVERTE — EXTRAIT LIMITÉ",
    });

    const text = new TextDecoder().decode(pdf);

    expect(text).toContain("%PDF-1.4");
    expect(text).toContain("VERSION D\\311COUVERTE \\227 EXTRAIT LIMIT\\311");
    expect(text).toContain("0.707 0.707 -0.707 0.707");
  });
});
