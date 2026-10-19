import { describe, expect, it } from "vitest";

import { checkProductionSmoke, expectedIndexingState } from "./check-production-smoke.mjs";

const ORIGIN = "https://immojudis.com";
const UNKNOWN_SALE = "/sales/00000000-0000-4000-8000-000000000000";
const SALE_ID = "005a914d-563c-427b-88a4-740cbf851afb";
const SALE_PATH = `/sales/${SALE_ID}`;

function sitemapXml(urls) {
  return `<?xml version="1.0"?><urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
}

const PAGE_URLS = Array.from({ length: 16 }, (_, index) => `${ORIGIN}/page-${index}`);
const SALE_URLS = [
  `${ORIGIN}${SALE_PATH}`,
  ...Array.from({ length: 149 }, (_, index) => `${ORIGIN}/sales/s-${index}`),
];

const SALE_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [{ "@type": "RealEstateListing", name: "Appartement" }, { "@type": "BreadcrumbList" }],
}).replaceAll("<", "\\u003c");

function page(path, { canonical, robotsMeta, jsonLd } = {}) {
  const head = [
    canonical ? `<link rel="canonical" href="${ORIGIN}${canonical}"/>` : "",
    robotsMeta ? `<meta name="robots" content="${robotsMeta}"/>` : "",
    jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : "",
  ].join("");
  return `<html><head>${head}</head><body>Immojudis ${path}</body></html>`;
}

/**
 * A fake production. `indexing` is the state the site is really in; `overrides` replaces the
 * answer of one path (a function of the header helper), `headers` adds response headers per path.
 */
function fakeSite({ indexing = "closed", overrides = {}, robotsTxt } = {}) {
  const calls = [];
  const open = indexing === "open";
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    const path = `${pathname}${search}`;
    calls.push(path);
    const requestId = init.headers["x-request-id"];
    const makeHeaders = (contentType, extra = {}) => ({
      get: (name) => {
        const all = {
          "content-type": contentType,
          ...(requestId ? { "x-request-id": requestId } : {}),
          ...(open ? {} : { "x-robots-tag": "noindex, nofollow" }),
          ...extra,
        };
        return all[name.toLowerCase()] ?? null;
      },
    });
    const override = overrides[path];
    if (override) return override(makeHeaders);
    const html = (body, extra) => ({
      status: 200,
      headers: makeHeaders("text/html; charset=utf-8", extra),
      text: async () => body,
    });
    if (path === UNKNOWN_SALE) {
      return {
        status: 404,
        headers: makeHeaders("text/html; charset=utf-8"),
        body: { cancel: async () => undefined },
      };
    }
    if (path.startsWith("/api/lawyers")) {
      return {
        status: 200,
        headers: makeHeaders("application/json"),
        json: async () => ({ lawyers: [] }),
      };
    }
    if (path === "/robots.txt") {
      const sitemaps = open
        ? `Sitemap: ${ORIGIN}/sitemap.xml\nSitemap: ${ORIGIN}/ressources/sitemap.xml\nSitemap: ${ORIGIN}/sales/sitemap/0.xml\n`
        : "";
      return {
        status: 200,
        headers: makeHeaders("text/plain"),
        text: async () =>
          robotsTxt ?? `User-Agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n${sitemaps}`,
      };
    }
    if (path === "/sitemap.xml") {
      return {
        status: 200,
        headers: makeHeaders("application/xml"),
        text: async () => sitemapXml(PAGE_URLS),
      };
    }
    if (path === "/sales/sitemap/0.xml") {
      return {
        status: 200,
        headers: makeHeaders("application/xml"),
        text: async () => sitemapXml(SALE_URLS),
      };
    }
    if (path === SALE_PATH) {
      return html(page(path, { canonical: SALE_PATH, jsonLd: SALE_JSON_LD }), {
        "x-robots-tag": open ? null : "noindex, nofollow",
      });
    }
    if (path === "/login") return html(page(path, { robotsMeta: "noindex, nofollow" }));
    const canonical = ["/", "/sales", "/annonce-exemple"].includes(path) ? path : undefined;
    return html(page(path, { canonical }));
  };
  return { fetchImpl, calls };
}

const run = (site, options = {}) =>
  checkProductionSmoke({ origin: ORIGIN, fetchImpl: site.fetchImpl, ...options });

describe("expected indexing state", () => {
  it("is open only for SEO_INDEXING_ENABLED=true, like the site itself", () => {
    expect(expectedIndexingState("true")).toBe("open");
    expect(expectedIndexingState(" true ")).toBe("open");
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(expectedIndexingState(value)).toBe("closed");
    }
  });
});

describe("production smoke test", () => {
  it("passes when an unknown sale answers a real 404", async () => {
    const site = fakeSite();
    const report = await run(site, { indexing: "closed" });

    expect(site.calls).toContain(UNKNOWN_SALE);
    expect(report.checks.find((check) => check.path === UNKNOWN_SALE)?.status).toBe(404);
  });

  it("fails when an unknown sale answers 200 (soft 404)", async () => {
    const site = fakeSite({
      overrides: {
        [UNKNOWN_SALE]: (headers) => ({
          status: 200,
          headers: headers("text/html; charset=utf-8"),
          text: async () => page(UNKNOWN_SALE),
        }),
      },
    });

    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      `${UNKNOWN_SALE}: statut HTTP 200 au lieu de 404.`,
    );
  });

  it("still requires a 200 on the other pages", async () => {
    const site = fakeSite({
      overrides: {
        "/legal": (headers) => ({
          status: 404,
          headers: headers("text/html"),
          text: async () => "",
        }),
      },
    });

    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/legal: statut HTTP 404 au lieu de 200.",
    );
  });

  it("requires /login to be noindex", async () => {
    const site = fakeSite({
      overrides: {
        "/login": (headers) => ({
          status: 200,
          headers: headers("text/html", { "x-robots-tag": null }),
          text: async () => page("/login"),
        }),
      },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/login: balise robots noindex absente.",
    );
  });
});

describe("production smoke test, indexing open", () => {
  it("passes and reports what it checked", async () => {
    const site = fakeSite({ indexing: "open" });
    const report = await run(site, { indexing: "open" });
    expect(report.indexing).toBe("open");
    const paths = report.checks.map((check) => check.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/login",
        "/robots.txt",
        "/sitemap.xml",
        "/sales/sitemap/0.xml",
        SALE_PATH,
      ]),
    );
    expect(report.checks.find((check) => check.path === "/sales/sitemap/0.xml")?.urls).toBe(150);
  });

  it("takes the sale to check from the sales sitemap", async () => {
    const site = fakeSite({ indexing: "open" });
    await run(site, { indexing: "open" });
    expect(site.calls).toContain(SALE_PATH);
  });

  it("fails when robots.txt has no Sitemap line", async () => {
    const site = fakeSite({ indexing: "open", robotsTxt: "User-Agent: *\nAllow: /\n" });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "/robots.txt: aucune ligne Sitemap: alors que l'indexation est ouverte.",
    );
  });

  it("fails when robots.txt blocks the whole site", async () => {
    const site = fakeSite({
      indexing: "open",
      robotsTxt: `User-Agent: *\nDisallow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "« Disallow: / » alors que l'indexation est ouverte",
    );
  });

  it("allows the private Disallow rules (only « Disallow: / » alone is a block)", async () => {
    const site = fakeSite({ indexing: "open" });
    await expect(run(site, { indexing: "open" })).resolves.toMatchObject({ ok: true });
  });

  it("fails when the home page still carries X-Robots-Tag", async () => {
    const site = fakeSite({
      indexing: "open",
      overrides: {
        "/": (headers) => ({
          status: 200,
          headers: headers("text/html", { "x-robots-tag": "noindex, nofollow" }),
          text: async () => page("/", { canonical: "/" }),
        }),
      },
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "/: en-tête X-Robots-Tag « noindex, nofollow » présent alors que l'indexation est ouverte.",
    );
  });

  it("fails when /sitemap.xml lists too few URLs", async () => {
    const site = fakeSite({ indexing: "open" });
    await expect(run(site, { indexing: "open", minPageUrls: 50 })).rejects.toThrow(
      "/sitemap.xml: 16 URL au lieu d'au moins 50.",
    );
  });

  it("fails when the sales sitemap lists too few URLs", async () => {
    const site = fakeSite({ indexing: "open" });
    await expect(run(site, { indexing: "open", minSaleUrls: 1000 })).rejects.toThrow(
      "/sales/sitemap/0.xml: 150 URL au lieu d'au moins 1000.",
    );
  });

  it("fails when /sitemap.xml does not answer 200", async () => {
    const site = fakeSite({
      indexing: "open",
      overrides: {
        "/sitemap.xml": (headers) => ({
          status: 500,
          headers: headers("text/html"),
          text: async () => "",
        }),
      },
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "/sitemap.xml: statut HTTP 500 au lieu de 200.",
    );
  });

  it("fails when the sale listed in the sitemap is noindex", async () => {
    const site = fakeSite({
      indexing: "open",
      overrides: {
        [SALE_PATH]: (headers) => ({
          status: 200,
          headers: headers("text/html", {}),
          text: async () =>
            page(SALE_PATH, {
              canonical: SALE_PATH,
              robotsMeta: "noindex, follow",
              jsonLd: SALE_JSON_LD,
            }),
        }),
      },
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "fiche listée au sitemap mais en noindex",
    );
  });

  it("fails when the sale canonical is not its own address", async () => {
    const site = fakeSite({
      indexing: "open",
      overrides: {
        [SALE_PATH]: (headers) => ({
          status: 200,
          headers: headers("text/html", {}),
          text: async () => page(SALE_PATH, { canonical: "/sales", jsonLd: SALE_JSON_LD }),
        }),
      },
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      `${SALE_PATH}: URL canonique ${ORIGIN}${SALE_PATH} absente`,
    );
  });

  it("fails when the sale JSON-LD is missing or not valid JSON", async () => {
    for (const [jsonLd, message] of [
      [undefined, "données structurées JSON-LD absentes"],
      ["{not json", "JSON-LD invalide"],
      [
        JSON.stringify({ "@context": "https://schema.org", "@type": "Thing" }),
        "sans RealEstateListing",
      ],
    ]) {
      const site = fakeSite({
        indexing: "open",
        overrides: {
          [SALE_PATH]: (headers) => ({
            status: 200,
            headers: headers("text/html", {}),
            text: async () => page(SALE_PATH, { canonical: SALE_PATH, jsonLd }),
          }),
        },
      });
      await expect(run(site, { indexing: "open" })).rejects.toThrow(message);
    }
  });

  it("tries the next sale when one has expired since the sitemap was built", async () => {
    const site = fakeSite({
      indexing: "open",
      overrides: {
        [SALE_PATH]: (headers) => ({
          status: 404,
          headers: headers("text/html"),
          body: { cancel: async () => undefined },
        }),
        "/sales/s-0": (headers) => ({
          status: 200,
          headers: headers("text/html", {}),
          text: async () => page("/sales/s-0", { canonical: "/sales/s-0", jsonLd: SALE_JSON_LD }),
        }),
      },
    });
    const report = await run(site, { indexing: "open" });
    expect(report.checks.map((check) => check.path)).toContain("/sales/s-0");
  });

  it("fails when none of the first listed sales answers", async () => {
    const gone = (headers) => ({
      status: 404,
      headers: headers("text/html"),
      body: { cancel: async () => undefined },
    });
    const site = fakeSite({
      indexing: "open",
      overrides: { [SALE_PATH]: gone, "/sales/s-0": gone, "/sales/s-1": gone },
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "Aucune fiche du sitemap n'a répondu 200",
    );
  });
});

describe("production smoke test, indexing closed", () => {
  it("passes on a closed site: noindex on the home page, no sitemap in robots.txt", async () => {
    const site = fakeSite({ indexing: "closed" });
    const report = await run(site, { indexing: "closed" });
    expect(report.indexing).toBe("closed");
    expect(site.calls).not.toContain("/sitemap.xml");
    expect(site.calls).not.toContain(SALE_PATH);
  });

  it("fails when the site is open although it should be closed", async () => {
    const site = fakeSite({ indexing: "open" });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/: en-tête X-Robots-Tag noindex absent alors que l'indexation est fermée.",
    );
  });

  it("fails when robots.txt advertises a sitemap on a closed site", async () => {
    const site = fakeSite({
      indexing: "closed",
      robotsTxt: `User-Agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "des lignes Sitemap: sont publiées alors que l'indexation est fermée",
    );
  });

  it("fails when the site is closed although it should be open", async () => {
    const site = fakeSite({ indexing: "closed" });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "X-Robots-Tag « noindex, nofollow » présent alors que l'indexation est ouverte",
    );
  });

  it("rejects an unknown expected state", async () => {
    await expect(run(fakeSite(), { indexing: "maybe" })).rejects.toThrow(
      "État d'indexation attendu invalide",
    );
  });
});
