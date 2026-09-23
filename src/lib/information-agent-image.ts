import sharp from "sharp";

export const MAX_PUBLISHED_PHOTO_BYTES = 2 * 1024 * 1024;

/** Build a small, browser-readable derivative. The private original remains evidence. */
export async function optimizeInformationAgentPhoto(input: Uint8Array): Promise<Uint8Array> {
  let format: string | undefined;
  try {
    const metadata = await sharp(input, {
      limitInputPixels: 40_000_000,
      failOn: "error",
    }).metadata();
    format = metadata.format;
  } catch {
    throw new Error("Photo illisible ou trop grande : publication impossible.");
  }
  if (!format || !["jpeg", "png", "webp", "heif"].includes(format)) {
    throw new Error("Format photo non pris en charge pour publication.");
  }

  for (const [edge, quality] of [
    [1920, 78],
    [1600, 70],
    [1280, 62],
  ] as const) {
    try {
      const output = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (output.byteLength <= MAX_PUBLISHED_PHOTO_BYTES) return output;
    } catch {
      throw new Error("Photo impossible à convertir en WebP : publication suspendue.");
    }
  }
  throw new Error("Photo trop volumineuse après compression : publication suspendue.");
}
