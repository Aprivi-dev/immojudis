type TextPdfInput = {
  title: string;
  lines: string[];
  footer?: string;
  watermark?: string | null;
};

const PAGE_LINE_LIMIT = 42;

export function createTextPdf({ title, lines, footer, watermark }: TextPdfInput): Uint8Array {
  const cleanedTitle = sanitizePdfText(title).slice(0, 120);
  const cleanedLines = lines.flatMap(splitLongLine).map(sanitizePdfText).filter(Boolean);
  const cleanedWatermark = watermark ? sanitizePdfText(watermark).slice(0, 80) : null;
  const pages = chunk(cleanedLines, PAGE_LINE_LIMIT);
  if (pages.length === 0) pages.push(["Rapport ImmoJudis"]);

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const pageObjectIds: number[] = [];
  pages.forEach((pageLines, index) => {
    const pageObjectId = 4 + index * 2;
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
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objects[contentObjectId] =
      `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`;
  });

  objects[2] = `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] >>`;

  return writePdf(objects);
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
  lines: string[];
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

  out.push(
    "BT",
    "/F1 16 Tf",
    "50 792 Td",
    `(${escapePdfString(title)}) Tj`,
    "/F1 10 Tf",
    "0 -28 Td",
  );

  lines.forEach((line, index) => {
    if (index > 0) out.push("0 -15 Td");
    out.push(`(${escapePdfString(line)}) Tj`);
  });

  out.push("ET");
  out.push("BT");
  out.push("/F1 8 Tf");
  out.push("50 36 Td");
  out.push(
    `(${escapePdfString(footer ?? "ImmoJudis - rapport indicatif, a verifier dans les pieces officielles.")}) Tj`,
  );
  out.push("420 0 Td");
  out.push(`(${pageNumber}/${pageCount}) Tj`);
  out.push("ET");

  return out.join("\n");
}

function writePdf(objects: string[]): Uint8Array {
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
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function splitLongLine(line: string): string[] {
  const clean = line.trim();
  if (clean.length <= 92) return [clean];
  const parts: string[] = [];
  let cursor = clean;
  while (cursor.length > 92) {
    const cut = cursor.lastIndexOf(" ", 92);
    const end = cut > 40 ? cut : 92;
    parts.push(cursor.slice(0, end).trim());
    cursor = cursor.slice(end).trim();
  }
  if (cursor) parts.push(cursor);
  return parts;
}

function sanitizePdfText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[€]/g, "EUR")
    .replace(/[’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfString(value: string): string {
  return value.replace(/[\\()]/g, "\\$&");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
