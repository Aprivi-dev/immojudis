// Read-only browser feasibility probe. No CAPTCHA interaction or stored sessions.
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const source = process.env.PROBE_SOURCE;
if (!["encheres_immobilieres", "encheres_publiques"].includes(source)) {
  throw new Error(`Unsupported probe source: ${source || "missing"}`);
}
if (
  source === "encheres_publiques" &&
  (process.env.ENABLE_ENCHERES_PUBLIQUES_BENCHMARK !== "true" ||
    process.env.ENCHERES_PUBLIQUES_ACCESS_AUTHORIZED !== "true")
) {
  throw new Error(
    "Encheres Publiques probe refused until benchmark and access authorization are explicitly configured",
  );
}
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const context = await browser.newContext({ locale: "fr-FR" });
const page = await context.newPage();
const results = [];
const urls =
  source === "encheres_immobilieres"
    ? ["https://encheresimmobilieres.fr/biens-en-vente"]
    : ["https://www.encheres-publiques.com/ventes/immobilier"];
try {
  for (const url of urls) {
    try {
      const started = Date.now();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      const result = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        chars: document.body.innerText.length,
        inventoryTotals: document.body.innerText.match(/\d+\s+biens en ventes?/gi) ?? [],
        paginationButtons: [...document.querySelectorAll("button")]
          .filter((button) => /^(?:\d+|[<>]|\.\.\.)$/.test(button.textContent.trim()))
          .map((button) => button.outerHTML),
        links: [...document.querySelectorAll("a[href]")]
          .map((a) => a.href)
          .filter((h) => h.includes("/ventes/") || h.includes("/biens-en-vente")),
      }));
      results.push({
        requestedUrl: url,
        status: response?.status(),
        elapsedMs: Date.now() - started,
        ...result,
      });
    } catch (error) {
      results.push({ requestedUrl: url, error: error.message });
    }
  }
} finally {
  await browser.close();
}
await mkdir("data/audits", { recursive: true });
await writeFile(
  "data/audits/browser-probe.json",
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
);
console.log(
  JSON.stringify(
    results.map(({ links, ...r }) => ({ ...r, links: links?.length })),
    null,
    2,
  ),
);
