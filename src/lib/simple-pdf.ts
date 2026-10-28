type TextPdfInput = {
  title: string;
  lines: string[];
  headings?: readonly string[];
  footer?: string;
  watermark?: string | null;
};

const PAGE_LINE_LIMIT = 42;
// A4 (595 pt) moins 50 pt de marge de chaque côté : largeur utile d'une ligne de texte.
const TEXT_WIDTH_PT = 495;
const BODY_SIZE = 10;
const TITLE_SIZE = 16;
const TITLE_MAX_LINES = 2;
const TITLE_MAX_CHARS = 200;
const FOOTER_SIZE = 8;
// Le numéro de page est écrit à x = 470 (50 + 420) : le pied de page ne doit pas le recouvrir.
const PAGE_NUMBER_OFFSET_PT = 420;
const FOOTER_WIDTH_PT = 410;
const FOOTER_LEADING_PT = 10;

export function createTextPdf({
  title,
  lines,
  footer,
  watermark,
  headings = [],
}: TextPdfInput): Uint8Array {
  const cleanedTitle = sanitizePdfText(title).slice(0, TITLE_MAX_CHARS);
  const cleanedWatermark = watermark ? sanitizePdfText(watermark).slice(0, 80) : null;
  const pages = paginatePdfLines(lines, headings);
  if (pages.length === 0) pages.push([{ text: "Rapport Immojudis", heading: false }]);

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R /Lang (fr-FR) >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  const pageObjectIds: number[] = [];
  pages.forEach((pageLines, index) => {
    const pageObjectId = 5 + index * 2;
    const contentObjectId = pageObjectId + 1;
    pageObjectIds.push(pageObjectId);
    const content = pageContent({
      title: index === 0 ? cleanedTitle : `${cleanedTitle} - suite`,
      lines: pageLines,
      pageNumber: index + 1,
      pageCount: pages.length,
      footer: footer ? sanitizePdfText(footer) : null,
      watermark: cleanedWatermark,
    });
    objects[pageObjectId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objects[contentObjectId] =
      `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`;
  });

  objects[2] = `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] >>`;

  // Titre du document (barre de titre et onglet du lecteur). Ni date de création ni producteur
  // variable : à lignes égales, le fichier reste identique octet pour octet.
  const infoObjectId = 5 + pages.length * 2;
  objects[infoObjectId] = `<< /Title ${pdfTextString(cleanedTitle || "Rapport Immojudis")} >>`;

  return writePdf(objects, infoObjectId);
}

function pageContent({
  title,
  lines,
  pageNumber,
  pageCount,
  footer,
  watermark,
}: {
  title: string;
  lines: PdfLine[];
  pageNumber: number;
  pageCount: number;
  footer: string | null;
  watermark: string | null;
}): string {
  const out: string[] = [];

  if (watermark) {
    out.push("q");
    out.push("0.88 g");
    out.push("BT");
    out.push("/F1 42 Tf");
    out.push("0.707 0.707 -0.707 0.707 98 320 Tm");
    out.push(`(${escapePdfString(watermark)}) Tj`);
    out.push("ET");
    out.push("Q");
    out.push("0 g");
  }

  out.push("BT", `/F1 ${TITLE_SIZE} Tf`, "50 792 Td");
  wrapPdfTitle(title).forEach((titleLine, index) => {
    if (index > 0) out.push("0 -18 Td");
    out.push(`(${escapePdfString(titleLine)}) Tj`);
  });
  out.push(`/F1 ${BODY_SIZE} Tf`, "0 -28 Td");

  lines.forEach((line, index) => {
    if (index > 0) out.push("0 -15 Td");
    out.push(line.heading ? `/F2 ${BODY_SIZE} Tf` : `/F1 ${BODY_SIZE} Tf`);
    out.push(`(${escapePdfString(line.text)}) Tj`);
  });

  out.push("ET");
  out.push("BT");
  out.push(`/F1 ${FOOTER_SIZE} Tf`);
  out.push("50 36 Td");
  const footerLines = wrapPdfText(
    footer ?? "Immojudis - rapport indicatif, à vérifier dans les pièces officielles.",
    FOOTER_SIZE,
    false,
    FOOTER_WIDTH_PT,
  );
  footerLines.forEach((footerLine, index) => {
    if (index > 0) out.push(`0 -${FOOTER_LEADING_PT} Td`);
    out.push(`(${escapePdfString(footerLine)}) Tj`);
  });
  // Retour sur la première ligne du pied de page, puis décalage jusqu'au numéro de page.
  out.push(`${PAGE_NUMBER_OFFSET_PT} ${(footerLines.length - 1) * FOOTER_LEADING_PT} Td`);
  out.push(`(${pageNumber}/${pageCount}) Tj`);
  out.push("ET");

  return out.join("\n");
}

function writePdf(objects: string[], infoObjectId: number): Uint8Array {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = byteLength(pdf);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

type PdfLine = { text: string; heading: boolean };

/**
 * Ligne spéciale : la page en cours est terminée et la suite commence sur une page neuve. Sans
 * effet sur une page vide (deux sauts de suite, ou un saut en tête, ne créent pas de page blanche).
 */
export const PDF_PAGE_BREAK = "\f";

export function paginatePdfLines(lines: string[], headings: readonly string[] = []): PdfLine[][] {
  const headingSet = new Set(headings.map(sanitizePdfText));
  const blocks = lines
    .map((line) => (line === PDF_PAGE_BREAK ? line : sanitizePdfText(line)))
    .filter(Boolean)
    .map((text) =>
      text === PDF_PAGE_BREAK
        ? { lines: [] as string[], heading: false, pageBreak: true }
        : {
            lines: splitLongLine(text, headingSet.has(text)),
            heading: headingSet.has(text),
            pageBreak: false,
          },
    );
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  const nextPage = () => {
    if (page.length) pages.push(page);
    page = [];
  };
  blocks.forEach((block, index) => {
    if (block.pageBreak) {
      nextPage();
      return;
    }
    const following = blocks[index + 1];
    const followingSize =
      block.heading && following
        ? following.lines.length + block.lines.length <= PAGE_LINE_LIMIT
          ? following.lines.length
          : 1
        : 0;
    const gap = block.heading && page.length ? 1 : 0;
    const required =
      block.lines.length > PAGE_LINE_LIMIT && !block.heading
        ? 1
        : Math.min(PAGE_LINE_LIMIT, block.lines.length + followingSize);
    if (page.length && page.length + gap + required > PAGE_LINE_LIMIT) nextPage();
    if (block.heading && page.length) page.push({ text: "", heading: false });
    for (const text of block.lines) {
      if (page.length === PAGE_LINE_LIMIT) nextPage();
      page.push({ text, heading: block.heading });
    }
  });
  nextPage();
  return pages;
}

/** Coupe une ligne de corps de texte selon sa largeur réelle en Helvetica, sur les espaces. */
function splitLongLine(line: string, bold: boolean): string[] {
  return wrapPdfText(line, BODY_SIZE, bold, TEXT_WIDTH_PT);
}

/** Titre : au plus deux lignes, la fin remplacée par « … » si elle ne tient pas. */
function wrapPdfTitle(title: string): string[] {
  const lines = wrapPdfText(title, TITLE_SIZE, false, TEXT_WIDTH_PT);
  if (lines.length <= TITLE_MAX_LINES) return lines;
  const kept = lines.slice(0, TITLE_MAX_LINES);
  let last = kept[TITLE_MAX_LINES - 1];
  while (last && textWidthPt(`${last}…`, TITLE_SIZE, false) > TEXT_WIDTH_PT) {
    last = last.slice(0, -1).trimEnd();
  }
  kept[TITLE_MAX_LINES - 1] = `${last}…`;
  return kept;
}

function wrapPdfText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const clean = text.trim();
  if (!clean) return [clean];
  const widthOf = (value: string) => textWidthPt(value, size, bold);
  const lines: string[] = [];
  let current = "";
  // Seule l'espace ordinaire (U+0020) autorise une coupure : une espace insécable lie un montant
  // à son unité.
  for (const word of clean.split(" ").filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (widthOf(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    // Mot plus large qu'une ligne (URL, suite de chiffres) : coupe au caractère.
    while (widthOf(current) > maxWidth) {
      let end = current.length - 1;
      while (end > 1 && widthOf(current.slice(0, end)) > maxWidth) end -= 1;
      lines.push(current.slice(0, end));
      current = current.slice(end);
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Largeur d'un texte en points, d'après les métriques Helvetica / Helvetica-Bold (AFM Adobe, en
 * millièmes de corps). Une lettre accentuée a la largeur de sa lettre de base.
 */
export function textWidthPt(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const character of text) {
    units += glyphWidth(character, bold);
  }
  return (units * size) / 1000;
}

function glyphWidth(character: string, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const code = character.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return table[code - 0x20];
  const special = SPECIAL_WIDTHS[character];
  if (special) return special[bold ? 1 : 0];
  const base = character.normalize("NFD").charCodeAt(0);
  if (base >= 0x20 && base <= 0x7e) return table[base - 0x20];
  // Caractère inconnu : largeur d'une capitale large, par prudence.
  return 778;
}

// Largeurs des codes 0x20 (espace) à 0x7E (tilde).
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// [Helvetica, Helvetica-Bold] des signes hors ASCII qui n'ont pas de lettre de base.
const SPECIAL_WIDTHS: Record<string, readonly [number, number]> = {
  "\u00A0": [278, 278],
  "€": [556, 556],
  Œ: [1000, 1000],
  œ: [944, 944],
  Æ: [1000, 1000],
  æ: [889, 889],
  ß: [611, 611],
  "‘": [222, 278],
  "’": [222, 278],
  "“": [333, 500],
  "”": [333, 500],
  "–": [556, 556],
  "—": [1000, 1000],
  "…": [1000, 1000],
  "•": [350, 350],
  "°": [400, 400],
  "²": [333, 333],
  "³": [333, 333],
  "«": [556, 556],
  "»": [556, 556],
  "×": [584, 584],
  "÷": [584, 584],
  "±": [584, 584],
  "©": [737, 737],
  "®": [737, 737],
};

function sanitizePdfText(value: string): string {
  return (
    value
      .normalize("NFC")
      // Les espaces fines et insécables restent liées : U+202F et U+00A0 deviennent U+00A0, qui
      // existe en WinAnsi (0xA0). Un montant « 123 456 € » ne se coupe plus avant son unité.
      .replace(/[\u202F\u00A0]/g, "\u00A0")
      .replace(/\u2011/g, "-")
      // WinAnsi has neither ≤ nor ≥; dropping them would reverse the meaning of « hauteur ≤ 9 m ».
      .replace(/≤\s*/g, "au plus ")
      .replace(/≥\s*/g, "au moins ")
      .replace(/\s*≠\s*/g, " différent de ")
      .replace(/\s*≈\s*/g, " environ ")
      .replace(/\s*→\s*/g, " vers ")
      .replace(/[^\x20-\x7E\u00A0-\u00FF€ŒœŸŠšŽž‘’“”–—…•]/g, " ")
      // Toute espace sauf l'insécable : seule U+0020 permet une coupure de ligne.
      .replace(/[^\S\u00A0]+/g, " ")
      .replace(/^[ \u00A0]+|[ \u00A0]+$/g, "")
  );
}

/** Chaîne de texte PDF en hexadécimal UTF-16BE avec BOM, pour le dictionnaire /Info. */
function pdfTextString(value: string): string {
  let hex = "FEFF";
  for (let index = 0; index < value.length; index += 1) {
    hex += value.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

function escapePdfString(value: string): string {
  return Array.from(value, (character) => {
    if (/[\\()]/.test(character)) return `\\${character}`;
    const code = WIN_ANSI_SPECIAL[character] ?? character.charCodeAt(0);
    return code > 0x7e ? `\\${code.toString(8).padStart(3, "0")}` : character;
  }).join("");
}

// Standard PDF Helvetica uses single-byte WinAnsi, not UTF-8. Octal escapes
// preserve the glyphs while keeping streams and cross-reference offsets ASCII.
const WIN_ANSI_SPECIAL: Record<string, number> = {
  "€": 0x80,
  Œ: 0x8c,
  œ: 0x9c,
  Ÿ: 0x9f,
  Š: 0x8a,
  š: 0x9a,
  Ž: 0x8e,
  ž: 0x9e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "–": 0x96,
  "—": 0x97,
  "…": 0x85,
  "•": 0x95,
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
