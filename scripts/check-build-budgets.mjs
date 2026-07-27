import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_CLIENT_CHUNK_BYTES = 2_000_000;
const MAX_TOTAL_CLIENT_JS_BYTES = 5_000_000;
const MAX_LANDING_IMAGE_BYTES = 400_000;

const requiredHtml = [
  [".next/server/app/index.html", "L'immobilier judiciaire"],
  [".next/server/app/sales.html", "Ventes immobilières judiciaires"],
  [".next/server/app/annonce-exemple.html", "Exemple de rapport"],
];

for (const [path, expectedText] of requiredHtml) {
  const html = await readFile(path, "utf8");
  if (!html.includes("<h1") || !html.includes(expectedText)) {
    throw new Error(`${path} ne contient pas le HTML SSR utile attendu (${expectedText}).`);
  }
}

const chunks = await filesUnder(".next/static/chunks", (path) => path.endsWith(".js"));
const chunkSizes = await Promise.all(chunks.map(async (path) => [path, (await stat(path)).size]));
const totalClientBytes = chunkSizes.reduce((sum, [, size]) => sum + size, 0);
const [largestChunk, largestChunkBytes] = chunkSizes.sort(
  (left, right) => right[1] - left[1],
)[0] ?? ["none", 0];

if (largestChunkBytes > MAX_CLIENT_CHUNK_BYTES) {
  throw new Error(
    `Chunk client trop lourd: ${largestChunk} (${largestChunkBytes} octets > ${MAX_CLIENT_CHUNK_BYTES}).`,
  );
}
if (totalClientBytes > MAX_TOTAL_CLIENT_JS_BYTES) {
  throw new Error(
    `JavaScript client total trop lourd: ${totalClientBytes} octets > ${MAX_TOTAL_CLIENT_JS_BYTES}.`,
  );
}

const landingImages = await filesUnder("public/media/landing", (path) => path.endsWith(".webp"));
for (const path of landingImages) {
  const bytes = (await stat(path)).size;
  if (bytes > MAX_LANDING_IMAGE_BYTES) {
    throw new Error(`Image landing trop lourde: ${path} (${bytes} octets).`);
  }
}

console.info(
  JSON.stringify({
    largestChunk,
    largestChunkBytes,
    landingWebpCount: landingImages.length,
    totalClientBytes,
  }),
);

async function filesUnder(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(path, predicate);
      return predicate(path) ? [path] : [];
    }),
  );
  return nested.flat();
}
