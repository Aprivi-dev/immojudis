// Read-only source audit. Fresh browser context; no authentication or CAPTCHA handling.
// Usage: node scripts/audit-source-browser.mjs <manifest.json> <output-directory>
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error("Provide a manifest and output directory");
const entries = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(entries) || entries.length > 30) throw new Error("Expected at most 30 pages");
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "fr-FR",
  viewport: { width: 1440, height: 1000 },
});
const results = [];
try {
  for (const entry of entries) {
    if (!/^[a-z0-9_-]+$/.test(entry.id) || new URL(entry.url).protocol !== "https:") {
      throw new Error("Invalid public capture entry");
    }
    const page = await context.newPage();
    const result = { ...entry, checked_at: new Date().toISOString(), state: "capture_failed" };
    try {
      const response = await page.goto(entry.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      result.http_status = response?.status() ?? null;
      if (response)
        await writeFile(resolve(output, `${entry.id}-response.html`), await response.text());
      await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
      if (entry.dismissCookieButton) {
        const reject = page.getByRole("button", { name: entry.dismissCookieButton, exact: true });
        await reject.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
        // Consent managers can render the button before its handler is
        // attached. Give the page a short settling window, then retry the
        // visible button while checking the modal layers (the sticky deny
        // button itself may remain visible after a successful dismissal).
        await page.waitForTimeout(1200);
        let dismissed = false;
        for (let attempt = 0; attempt < 3 && !dismissed; attempt += 1) {
          for (let index = 0; index < (await reject.count()); index += 1) {
            const candidate = reject.nth(index);
            if (await candidate.isVisible().catch(() => false)) {
              await candidate.click({ timeout: 5000 });
              break;
            }
          }
          await page.waitForTimeout(750);
          dismissed =
            (await page
              .locator("#tarteaucitronAlertBig:visible, #tarteaucitron:visible")
              .count()) === 0;
        }
        if (dismissed) result.cookie_banner_dismissed = true;
      }
      // Scroll through the page to observe ordinary lazy-loaded listing images.
      await page.evaluate(async () => {
        const bottom = Math.min(document.documentElement.scrollHeight, 30000);
        for (let y = 0; y < bottom; y += 900) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 80));
        }
        window.scrollTo(0, 0);
      });
      const inventory = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
        meta: [...document.querySelectorAll("meta[name], meta[property]")].map((n) => ({
          name: n.getAttribute("name") ?? n.getAttribute("property"),
          content: n.content,
        })),
        headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((n) => ({
          tag: n.tagName,
          text: n.innerText,
          id: n.id,
        })),
        text: document.body.innerText,
        blocks: [...document.querySelectorAll("main,article,section,p,li,dt,dd,th,td")]
          .map((n) => ({ tag: n.tagName, id: n.id, class: n.className, text: n.innerText }))
          .filter((n) => n.text?.trim()),
        images: [...document.images].map((n) => ({
          src: n.src,
          currentSrc: n.currentSrc,
          srcset: n.srcset,
          dataSrc: n.getAttribute("data-src"),
          alt: n.alt,
          naturalWidth: n.naturalWidth,
          naturalHeight: n.naturalHeight,
          visible: Boolean(n.getClientRects().length),
        })),
        backgrounds: [...document.querySelectorAll("[style]")]
          .map((n) => ({
            tag: n.tagName,
            id: n.id,
            image: getComputedStyle(n).backgroundImage,
          }))
          .filter((n) => n.image !== "none"),
        links: [...document.querySelectorAll("a[href]")].map((n) => ({
          href: n.href,
          text: n.innerText,
        })),
        jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
          (n) => n.textContent,
        ),
      }));
      await writeFile(resolve(output, `${entry.id}-dom.html`), await page.content());
      await writeFile(
        resolve(output, `${entry.id}-inventory.json`),
        JSON.stringify(inventory, null, 2),
      );
      await page.screenshot({ path: resolve(output, `${entry.id}-viewport.png`), timeout: 20000 });
      await page.screenshot({
        path: resolve(output, `${entry.id}-full.png`),
        fullPage: true,
        timeout: 20000,
      });
      result.state = "captured";
      result.content_access = [401, 403].includes(result.http_status)
        ? "access_denied"
        : "observed";
      result.final_url = inventory.url;
      result.title = inventory.title;
      result.text_characters = inventory.text.length;
      result.image_elements = inventory.images.length;
    } catch (error) {
      result.error = `${error.name}: ${error.message}`;
      await page
        .screenshot({ path: resolve(output, `${entry.id}-error.png`), timeout: 10000 })
        .catch(() => {});
    } finally {
      await page.close();
    }
    results.push(result);
    await writeFile(resolve(output, "captures.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {
  await browser.close();
}
