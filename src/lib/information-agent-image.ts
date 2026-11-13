import sharp from "sharp";
import { PublicApiError } from "@/lib/api-errors";

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
    throw new PublicApiError("Photo illisible ou trop grande : publication impossible.", 422);
  }
  if (!format || !["jpeg", "png", "webp", "heif"].includes(format)) {
    throw new PublicApiError("Format photo non pris en charge pour publication.", 422);
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
      throw new PublicApiError(
        "Photo impossible à convertir en WebP : publication suspendue.",
        422,
      );
    }
  }
  throw new PublicApiError(
    "Photo trop volumineuse après compression : publication suspendue.",
    422,
  );
}
