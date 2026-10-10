import "server-only";

/**
 * Flattens a PDF before publication (plan P4-11): every page is rasterised and re-assembled as an
 * image-only PDF without Info dictionary or XMP metadata. Whatever was hidden underneath a
 * redaction box (text layer, annotations, form fields, attachments, author/producer metadata)
 * cannot survive: only the visible pixels are published.
 */
export const MAX_FLATTENED_PAGES = 60;
export const MAX_FLATTENED_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_PIXELS = 4_000_000;

type RenderedPage = { jpeg: Uint8Array; width: number; height: number };

export async function flattenPdfForPublication(input: Uint8Array): Promise<Uint8Array> {
  for (const [scale, quality] of [
    [1.6, 72],
    [1.25, 62],
    [1, 52],
  ] as const) {
    const pages = await renderPdfPages(input, scale, quality);
    const output = assembleImageOnlyPdf(pages);
    if (output.byteLength <= MAX_FLATTENED_BYTES) return output;
  }
  throw new Error("PDF trop volumineux après aplatissement : publication suspendue.");
}

async function renderPdfPages(
  input: Uint8Array,
  scale: number,
  quality: number,
): Promise<RenderedPage[]> {
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import("@napi-rs/canvas"),
    import("pdfjs-dist/legacy/build/pdf.mjs"),
  ]);
  const loadingTask = pdfjs.getDocument({
    // pdfjs transfers the buffer: hand it a copy so the caller's bytes stay usable.
    data: new Uint8Array(input),
    useWorkerFetch: false,
    disableFontFace: true,
    stopAtErrors: true,
  });
  let document: Awaited<typeof loadingTask.promise>;
  try {
    document = await loadingTask.promise;
  } catch {
    throw new Error("PDF illisible ou protégé : publication impossible.");
  }
  try {
    if (document.numPages < 1 || document.numPages > MAX_FLATTENED_PAGES) {
      throw new Error(`PDF de plus de ${MAX_FLATTENED_PAGES} pages : publication suspendue.`);
    }
    const pages: RenderedPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      let viewport = page.getViewport({ scale });
      const pixels = viewport.width * viewport.height;
      if (pixels > MAX_PAGE_PIXELS) {
        viewport = page.getViewport({ scale: scale * Math.sqrt(MAX_PAGE_PIXELS / pixels) });
      }
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;
      pages.push({ jpeg: new Uint8Array(canvas.toBuffer("image/jpeg", quality)), width, height });
      page.cleanup();
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

/** Minimal PDF writer: one JPEG (DCTDecode) per page, no Info dictionary, no XMP. */
export function assembleImageOnlyPdf(pages: readonly RenderedPage[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  const object = (id: number, body: Uint8Array | string, stream?: Uint8Array) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    push(body);
    if (stream) {
      push("\nstream\n");
      push(stream);
      push("\nendstream");
    }
    push("\nendobj\n");
  };

  // Object ids: 1 catalog, 2 pages, then three objects per page (page, content, image).
  push("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const content = encoder.encode(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`);
    object(contentId, `<< /Length ${content.byteLength} >>`, content);
    object(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.byteLength} >>`,
      page.jpeg,
    );
  });

  const objectCount = 3 + pages.length * 3;
  const xrefOffset = length;
  push(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let id = 1; id < objectCount; id += 1) {
    push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const output = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.byteLength;
  }
  return output;
}
