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

/** `count` sale links, as the catalogue renders them (`?from=` carries the search of the visitor). */
function listingLinks(count) {
  return Array.from(
    { length: count },
    (_, index) =>
      `<a href="/sales/00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}?from=%2Fsales">Vente ${index}</a>`,
  ).join("");
}

function page(path, { canonical, robotsMeta, jsonLd, links = "" } = {}) {
  const head = [
    canonical ? `<link rel="canonical" href="${ORIGIN}${canonical}"/>` : "",
    robotsMeta ? `<meta name="robots" content="${robotsMeta}"/>` : "",
    jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : "",
  ].join("");
  return `<html><head>${head}</head><body>Immojudis ${path}${links}</body></html>`;
}

/**
 * A fake production. `indexing` is the state the site is really in; `overrides` replaces the
 * answer of one path (a function of the header helper), `headers` adds response headers per path.
 */
function fakeSite({
  indexing = "closed",
  overrides = {},
  robotsTxt,
  // `x-vercel-cache` of the successive requests to /sales (the last one repeats).
  salesCache = ["MISS", "HIT"],
  sitemapExtra = [],
} = {}) {
  const calls = [];
  let salesRequests = 0;
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
    if (path === "/sales") {
      const cache = salesCache[Math.min(salesRequests, salesCache.length - 1)];
      salesRequests += 1;
      return html(page(path, { canonical: path, links: listingLinks(24) }), {
        "x-vercel-cache": cache,
      });
    }
    if (path === "/sales?page=2") {
      return html(page(path, { canonical: "/sales", links: listingLinks(24) }), {
        "x-vercel-cache": null,
      });
    }
    if (path === "/sales/defaut") {
      return {
        status: 307,
        headers: makeHeaders("text/html", { "x-robots-tag": "noindex, nofollow" }),
        body: { cancel: async () => undefined },
      };
    }
    if (path === "/api/catalogue/preview") {
      return {
        status: 200,
        headers: makeHeaders("application/json", {
          "cache-control": "public, s-maxage=60, stale-while-revalidate=60",
        }),
        json: async () => ({ items: [], count: 0, mirrors: [] }),
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
        text: async () => sitemapXml([...PAGE_URLS, ...sitemapExtra]),
      };
    }
    if (path === "/ressources/sitemap.xml") {
      return {
        status: 200,
        headers: makeHeaders("application/xml"),
        text: async () => sitemapXml([`${ORIGIN}/ressources/guide`, ...sitemapExtra]),
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
    const canonical = ["/", "/annonce-exemple"].includes(path) ? path : undefined;
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

describe("production smoke test, public catalogue and its caches", () => {
  const response = (headers, { status = 200, body = "", extra = {} } = {}) => ({
    status,
    headers: headers("text/html; charset=utf-8", extra),
    text: async () => body,
    json: async () => JSON.parse(body),
    body: { cancel: async () => undefined },
  });
  const salesPage = (links = listingLinks(24)) => page("/sales", { canonical: "/sales", links });

  it("passes and reports the cache hit, the listings and the preview headers", async () => {
    const site = fakeSite();
    const report = await run(site, { indexing: "closed" });
    const byPath = Object.fromEntries(report.checks.map((check) => [check.path, check]));

    expect(byPath["/sales (cache)"]).toMatchObject({ cache: "HIT", sales: 24 });
    expect(byPath["/sales/defaut"].status).toBe(307);
    expect(byPath["/sales?page=2"].sales).toBe(24);
    expect(byPath["/api/catalogue/preview"].cacheControl).toContain("public");
    // The generic check, then the two successive requests of the cache check.
    expect(site.calls.filter((path) => path === "/sales")).toHaveLength(3);
  });

  it("runs on an open site too, whatever the indexing state", async () => {
    await expect(run(fakeSite({ indexing: "open" }), { indexing: "open" })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("fails when the second request to /sales is not served by the cache", async () => {
    for (const cache of ["MISS", "STALE", "PRERENDER", "BYPASS"]) {
      await expect(run(fakeSite({ salesCache: [cache] }), { indexing: "closed" })).rejects.toThrow(
        `/sales: la 2e requête successive n'est pas servie par le cache (x-vercel-cache: ${cache} au lieu de HIT).`,
      );
    }
  });

  it("fails when x-vercel-cache is missing", async () => {
    const site = fakeSite({ salesCache: [null] });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow("x-vercel-cache: absent");
  });

  it("accepts a first request that already hits the cache", async () => {
    await expect(
      run(fakeSite({ salesCache: ["HIT"] }), { indexing: "closed" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([2, 3])("fails when request %i to /sales sets a cookie", async (cookieOn) => {
    let requests = 0;
    const site = fakeSite({
      overrides: {
        "/sales": (headers) => {
          requests += 1;
          return response(headers, {
            body: salesPage(),
            extra: { "x-vercel-cache": "HIT", "set-cookie": requests === cookieOn ? "sb=1" : null },
          });
        },
      },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/sales: en-tête Set-Cookie présent",
    );
  });

  it("fails when the cached /sales carries a Vary header", async () => {
    const site = fakeSite({
      overrides: {
        "/sales": (headers) =>
          response(headers, {
            body: salesPage(),
            extra: { "x-vercel-cache": "HIT", vary: "rsc, next-router-state-tree" },
          }),
      },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/sales: en-tête Vary « rsc, next-router-state-tree »",
    );
  });

  it("fails when the HTML of /sales holds no link to a sale", async () => {
    const site = fakeSite({
      overrides: {
        "/sales": (headers) =>
          response(headers, {
            body: salesPage('<a href="/sales/defaut">x</a><a href="/sales?page=2">y</a>'),
            extra: { "x-vercel-cache": "HIT" },
          }),
      },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/sales: aucun lien /sales/<identifiant> dans le HTML.",
    );
  });

  it("counts absolute links to a sale too", async () => {
    const site = fakeSite({
      overrides: {
        "/sales": (headers) =>
          response(headers, {
            body: salesPage(`<a href="${ORIGIN}/sales/${SALE_ID}">x</a>`),
            extra: { "x-vercel-cache": "HIT" },
          }),
      },
    });
    const report = await run(site, { indexing: "closed" });
    expect(report.checks.find((check) => check.path === "/sales (cache)")?.sales).toBe(1);
  });

  it("requires /sales/defaut to be noindex", async () => {
    const site = fakeSite({
      indexing: "open",
      overrides: {
        "/sales/defaut": (headers) =>
          response(headers, { status: 307, extra: { "x-robots-tag": null } }),
      },
    });
    await expect(run(site, { indexing: "open" })).rejects.toThrow(
      "/sales/defaut: en-tête X-Robots-Tag noindex absent.",
    );
  });

  it("does not follow the redirect of /sales/defaut: the header is read on the redirect itself", async () => {
    let redirect;
    const site = fakeSite();
    const fetchImpl = (url, init) => {
      if (new URL(url).pathname === "/sales/defaut") redirect = init.redirect;
      return site.fetchImpl(url, init);
    };
    await run({ fetchImpl }, { indexing: "closed" });
    expect(redirect).toBe("manual");
  });

  it("fails when /sales/defaut answers an error", async () => {
    const site = fakeSite({
      overrides: {
        "/sales/defaut": (headers) =>
          response(headers, { status: 500, extra: { "x-robots-tag": "noindex" } }),
      },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/sales/defaut: statut HTTP 500.",
    );
  });

  it.each([
    [0, false],
    [19, false],
    [20, true],
    [24, true],
  ])("requires at least 20 listings in /sales?page=2 (%i listings: %s)", async (count, passes) => {
    const site = fakeSite({
      overrides: {
        "/sales?page=2": (headers) =>
          response(headers, {
            body: page("/sales?page=2", { canonical: "/sales", links: listingLinks(count) }),
          }),
      },
    });
    const outcome = run(site, { indexing: "closed" });
    if (passes) await expect(outcome).resolves.toMatchObject({ ok: true });
    else {
      await expect(outcome).rejects.toThrow(
        `/sales?page=2: ${count} lien(s) de fiche dans le HTML au lieu d'au moins 20.`,
      );
    }
  });

  it("counts distinct sales only: the same link repeated is one listing", async () => {
    const site = fakeSite({
      overrides: {
        "/sales?page=2": (headers) =>
          response(headers, {
            body: page("/sales?page=2", {
              canonical: "/sales",
              links: `<a href="/sales/${SALE_ID}">a</a>`.repeat(30),
            }),
          }),
      },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/sales?page=2: 1 lien(s) de fiche",
    );
  });

  it("fails when /sales?page=2 is not answered with 200", async () => {
    const site = fakeSite({
      overrides: { "/sales?page=2": (headers) => response(headers, { status: 503 }) },
    });
    await expect(run(site, { indexing: "closed" })).rejects.toThrow(
      "/sales?page=2: statut HTTP 503 au lieu de 200.",
    );
  });

  it.each([undefined, "no-store", "private, no-store", "private, max-age=60", "max-age=60"])(
    "requires a public cache-control on the preview API (%s)",
    async (cacheControl) => {
      const site = fakeSite({
        overrides: {
          "/api/catalogue/preview": (headers) =>
            response(headers, {
              body: JSON.stringify({ items: [], count: 0, mirrors: [] }),
              extra: { "content-type": "application/json", "cache-control": cacheControl ?? null },
            }),
        },
      });
      await expect(run(site, { indexing: "closed" })).rejects.toThrow(
        `/api/catalogue/preview: cache-control « ${cacheControl ?? "absent"} » au lieu d'un cache public.`,
      );
    },
  );

  it("fails when the preview API answers an error or breaks its contract", async () => {
    const down = fakeSite({
      overrides: { "/api/catalogue/preview": (headers) => response(headers, { status: 503 }) },
    });
    await expect(run(down, { indexing: "closed" })).rejects.toThrow(
      "/api/catalogue/preview: statut HTTP 503 au lieu de 200.",
    );

    const broken = fakeSite({
      overrides: {
        "/api/catalogue/preview": (headers) =>
          response(headers, {
            body: JSON.stringify({ nope: true }),
            extra: { "cache-control": "public, s-maxage=60" },
          }),
      },
    });
    await expect(run(broken, { indexing: "closed" })).rejects.toThrow(
      "/api/catalogue/preview: contrat de la réponse invalide.",
    );
  });

  it.each([`${ORIGIN}/sales/defaut`, `${ORIGIN}/sales/defaut/`])(
    "fails when the pages sitemap lists %s (indexing open)",
    async (extra) => {
      const site = fakeSite({ indexing: "open", sitemapExtra: [extra] });
      await expect(run(site, { indexing: "open" })).rejects.toThrow(
        `/sitemap.xml: la variante interne ${extra} est listée au sitemap.`,
      );
    },
  );

  it("looks for it in every sitemap that robots.txt lists, the sales files included", async () => {
    const sales = fakeSite({
      indexing: "open",
      overrides: {
        "/sales/sitemap/0.xml": (headers) =>
          response(headers, {
            body: sitemapXml([...SALE_URLS, `${ORIGIN}/sales/defaut`]),
            extra: { "content-type": "application/xml" },
          }),
      },
    });
    await expect(run(sales, { indexing: "open" })).rejects.toThrow(
      "/sales/sitemap/0.xml: la variante interne https://immojudis.com/sales/defaut est listée",
    );

    const secondary = fakeSite({
      indexing: "open",
      overrides: {
        "/ressources/sitemap.xml": (headers) =>
          response(headers, {
            body: sitemapXml([`${ORIGIN}/sales/defaut`]),
            extra: { "content-type": "application/xml" },
          }),
      },
    });
    await expect(run(secondary, { indexing: "open" })).rejects.toThrow(
      "/ressources/sitemap.xml: la variante interne",
    );
  });

  it("does not mistake an address that merely starts like the variant", async () => {
    const site = fakeSite({
      indexing: "open",
      sitemapExtra: [`${ORIGIN}/sales/defaut-de-paiement`, `${ORIGIN}/ressources/sales/defaut`],
    });
    await expect(run(site, { indexing: "open" })).resolves.toMatchObject({ ok: true });
  });

  it("reports how many sitemaps were read", async () => {
    const report = await run(fakeSite({ indexing: "open" }), { indexing: "open" });
    expect(report.checks.find((check) => check.path === "sitemaps")?.count).toBe(3);
  });
});
