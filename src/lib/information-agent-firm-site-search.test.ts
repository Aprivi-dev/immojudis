import { describe, expect, it, vi } from "vitest";
import {
  FIRM_SITE_MAX_PAGES,
  informationAgentSearchUserAgent,
  isPrivateNetworkAddress,
  searchFirmWebsiteAddress,
  type FirmSiteSearchDeps,
} from "@/lib/information-agent/firm-site-search";

/**
 * Aucune requête réseau réelle : `fetch` et la résolution DNS sont simulés. Chaque test vérifie
 * aussi les requêtes émises (méthode, domaine, nombre, user-agent).
 */

type Route = {
  status?: number;
  body?: string;
  type?: string;
  headers?: Record<string, string>;
};

const HOME = "https://www.cabinet-dupont.fr/";
const USER_AGENT = informationAgentSearchUserAgent("https://immojudis.example");

function page(body: string, extra: Route = {}): Route {
  return { status: 200, type: "text/html; charset=utf-8", body, ...extra };
}

function harness(routes: Record<string, Route>, overrides: Partial<FirmSiteSearchDeps> = {}) {
  const calls: Array<{ url: string; method: string; userAgent: string | null }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", userAgent: headers.get("user-agent") });
    const route = routes[url];
    if (!route) return new Response("introuvable", { status: 404 });
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: {
        "content-type": route.type ?? (url.endsWith("/robots.txt") ? "text/plain" : "text/html"),
        ...route.headers,
      },
    });
  }) as unknown as typeof fetch;
  const lookupImpl = vi.fn(async () => [{ address: "93.184.216.34" }]);
  const deps: FirmSiteSearchDeps = {
    fetchImpl,
    lookupImpl,
    sleep: async () => undefined,
    ...overrides,
  };
  return { calls, deps, lookupImpl };
}

const pagesOf = (calls: Array<{ url: string }>) =>
  calls.filter((call) => !call.url.endsWith("/robots.txt"));

function search(
  deps: FirmSiteSearchDeps,
  extra: Partial<Parameters<typeof searchFirmWebsiteAddress>[0]> = {},
) {
  return searchFirmWebsiteAddress({
    startUrl: HOME,
    lawyerName: "Maître Jean Dupont",
    userAgent: USER_AGENT,
    pauseMs: 0,
    deps,
    ...extra,
  });
}

describe("recherche de l'adresse sur le site du cabinet", () => {
  it("retient l'adresse publiée, en GET, avec un user-agent qui identifie Immojudis", async () => {
    const { calls, deps } = harness({
      "https://www.cabinet-dupont.fr/robots.txt": { body: "User-agent: *\nDisallow: /admin" },
      [HOME]: page('<p>Cabinet Dupont — <a href="mailto:contact@cabinet-dupont.fr">écrire</a></p>'),
    });
    const result = await search(deps);

    expect(result).toEqual({
      status: "found",
      host: "cabinet-dupont.fr",
      pagesFetched: 1,
      email: "contact@cabinet-dupont.fr",
      pageUrl: HOME,
      reason: "single",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.cabinet-dupont.fr/robots.txt",
      HOME,
    ]);
    expect(USER_AGENT).toBe("ImmojudisAdresses/1.0 (+https://immojudis.example/contact)");
    for (const call of calls) expect(call.userAgent).toBe(USER_AGENT);
  });

  it("ne garde aucune copie de page : le résultat ne contient que l'adresse, l'URL et un compte", async () => {
    const { deps } = harness({
      [HOME]: page(`<p>Texte très long du cabinet. contact@cabinet-dupont.fr</p>`),
    });
    const result = await search(deps);
    expect(Object.keys(result).sort()).toEqual([
      "email",
      "host",
      "pageUrl",
      "pagesFetched",
      "reason",
      "status",
    ]);
    expect(JSON.stringify(result)).not.toContain("Texte très long");
  });

  it("lit au plus 3 pages par domaine, même si le site en propose davantage", async () => {
    const links = ["/contact", "/mentions-legales", "/le-cabinet", "/equipe", "/a-propos"]
      .map((href) => `<a href="${href}">${href}</a>`)
      .join("");
    const { calls, deps } = harness({
      [HOME]: page(`<nav>${links}</nav>`),
      "https://www.cabinet-dupont.fr/contact": page("<p>Formulaire</p>"),
      "https://www.cabinet-dupont.fr/mentions-legales": page("<p>Éditeur</p>"),
      "https://www.cabinet-dupont.fr/le-cabinet": page("<p>Présentation</p>"),
      "https://www.cabinet-dupont.fr/equipe": page("<p>Équipe</p>"),
    });
    const result = await search(deps);

    expect(FIRM_SITE_MAX_PAGES).toBe(3);
    expect(result.status).toBe("none");
    expect(result.pagesFetched).toBe(3);
    expect(pagesOf(calls)).toHaveLength(3);
    expect(pagesOf(calls).map((call) => call.url)).toEqual([
      HOME,
      "https://www.cabinet-dupont.fr/contact",
      "https://www.cabinet-dupont.fr/mentions-legales",
    ]);
  });

  it("s'arrête dès qu'une adresse sûre est retenue", async () => {
    const { calls, deps } = harness({
      [HOME]: page('<a href="/contact">Contact</a><p>cabinet@cabinet-dupont.fr</p>'),
      "https://www.cabinet-dupont.fr/contact": page("<p>autre@cabinet-dupont.fr</p>"),
    });
    const result = await search(deps);
    expect(result).toMatchObject({ status: "found", email: "cabinet@cabinet-dupont.fr" });
    expect(pagesOf(calls)).toHaveLength(1);
  });

  it("n'envoie aucune requête hors du domaine, même par lien ou par redirection", async () => {
    const { calls, deps, lookupImpl } = harness({
      [HOME]: page(
        '<a href="https://www.linkedin.com/in/dupont">Contact</a><a href="https://autre.example/contact">Contact</a><a href="/mentions-legales">Mentions légales</a>',
      ),
      "https://www.cabinet-dupont.fr/mentions-legales": {
        status: 302,
        headers: { location: "https://evil.example/contact" },
      },
    });
    const result = await search(deps);

    expect(result.status).toBe("none");
    const hosts = new Set(calls.map((call) => new URL(call.url).hostname));
    expect([...hosts]).toEqual(["www.cabinet-dupont.fr"]);
    expect([
      ...new Set(lookupImpl.mock.calls.map((call) => (call as unknown as [string])[0])),
    ]).toEqual(["www.cabinet-dupont.fr"]);
  });

  it("suit une redirection du même site (apex vers www, http non suivi)", async () => {
    const { calls, deps } = harness({
      "https://cabinet-dupont.fr/robots.txt": { status: 404 },
      "https://cabinet-dupont.fr/": {
        status: 301,
        headers: { location: "https://www.cabinet-dupont.fr/" },
      },
      [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
    });
    const result = await search(deps, { startUrl: "https://cabinet-dupont.fr/" });
    expect(result).toMatchObject({ status: "found", pageUrl: HOME });
    expect(calls.map((call) => call.url)).toEqual([
      "https://cabinet-dupont.fr/robots.txt",
      "https://cabinet-dupont.fr/",
      HOME,
    ]);

    const downgraded = harness({
      "https://cabinet-dupont.fr/": {
        status: 301,
        headers: { location: "http://cabinet-dupont.fr/" },
      },
    });
    expect((await search(downgraded.deps, { startUrl: "https://cabinet-dupont.fr/" })).status).toBe(
      "unreachable",
    );
    expect(pagesOf(downgraded.calls)).toHaveLength(1);
  });

  describe("robots.txt", () => {
    it("refuse quand le site interdit notre jeton, sans lire aucune page", async () => {
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": {
          body: "User-agent: ImmojudisAdresses\nDisallow: /",
        },
        [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
      });
      const result = await search(deps);
      expect(result).toMatchObject({ status: "robots_disallowed", pagesFetched: 0 });
      expect(calls.map((call) => call.url)).toEqual(["https://www.cabinet-dupont.fr/robots.txt"]);
    });

    it("refuse quand tous les robots sont interdits (`*`)", async () => {
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": { body: "User-agent: *\nDisallow: /" },
        [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
      });
      expect((await search(deps)).status).toBe("robots_disallowed");
      expect(pagesOf(calls)).toEqual([]);
    });

    it("saute seulement la page interdite et lit les autres", async () => {
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": { body: "User-agent: *\nDisallow: /contact" },
        [HOME]: page('<a href="/contact">Contact</a><a href="/mentions-legales">Mentions</a>'),
        "https://www.cabinet-dupont.fr/contact": page("<p>contact@cabinet-dupont.fr</p>"),
        "https://www.cabinet-dupont.fr/mentions-legales": page("<p>cabinet@cabinet-dupont.fr</p>"),
      });
      const result = await search(deps);
      expect(result).toMatchObject({ status: "found", email: "cabinet@cabinet-dupont.fr" });
      expect(pagesOf(calls).map((call) => call.url)).not.toContain(
        "https://www.cabinet-dupont.fr/contact",
      );
    });

    it("une redirection ne contourne pas robots.txt", async () => {
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": { body: "User-agent: *\nDisallow: /prive" },
        [HOME]: page('<a href="/contact">Contact</a>'),
        "https://www.cabinet-dupont.fr/contact": {
          status: 302,
          headers: { location: "/prive/contact" },
        },
        "https://www.cabinet-dupont.fr/prive/contact": page("<p>contact@cabinet-dupont.fr</p>"),
      });
      const result = await search(deps);
      expect(result.status).toBe("none");
      expect(calls.map((call) => call.url)).not.toContain(
        "https://www.cabinet-dupont.fr/prive/contact",
      );
    });

    it.each([
      ["erreur serveur", { status: 503, body: "" }],
      ["page HTML à la place du fichier", page("<html><body>Bienvenue</body></html>")],
      [
        "redirection hors domaine",
        { status: 301, headers: { location: "https://autre.example/robots.txt" } },
      ],
    ])("fichier illisible (%s) : aucune collecte", async (_label, route) => {
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": route,
        [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
      });
      const result = await search(deps);
      expect(result.status).toBe("robots_unreadable");
      expect(pagesOf(calls).filter((call) => call.url === HOME)).toEqual([]);
    });

    it("fichier injoignable (erreur réseau ou expiration) : aucune collecte", async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new DOMException("délai dépassé", "TimeoutError");
      }) as unknown as typeof fetch;
      const result = await search({
        fetchImpl,
        lookupImpl: async () => [{ address: "93.184.216.34" }],
        sleep: async () => undefined,
      });
      expect(result.status).toBe("robots_unreadable");
      expect(calls).toEqual(["https://www.cabinet-dupont.fr/robots.txt"]);
    });

    it("un fichier absent (404) n'interdit rien", async () => {
      const { deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": { status: 404 },
        [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
      });
      expect((await search(deps)).status).toBe("found");
    });

    it("refuse un Crawl-delay qu'on ne peut pas respecter", async () => {
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": { body: "User-agent: *\nCrawl-delay: 60" },
        [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
      });
      expect((await search(deps)).status).toBe("robots_disallowed");
      expect(pagesOf(calls)).toEqual([]);
    });
  });

  describe("arrêt sur blocage", () => {
    it.each([401, 403, 429])(
      "s'arrête sur une réponse %i du fichier robots.txt",
      async (status) => {
        const { calls, deps } = harness({
          "https://www.cabinet-dupont.fr/robots.txt": { status },
          [HOME]: page("<p>contact@cabinet-dupont.fr</p>"),
        });
        expect((await search(deps)).status).toBe("blocked");
        expect(calls).toHaveLength(1);
      },
    );

    it.each([403, 429])(
      "s'arrête sur une réponse %i d'une page, sans lire les suivantes",
      async (status) => {
        const { calls, deps } = harness({
          [HOME]: page('<a href="/contact">Contact</a><a href="/mentions-legales">Mentions</a>'),
          "https://www.cabinet-dupont.fr/contact": { status, body: "interdit" },
          "https://www.cabinet-dupont.fr/mentions-legales": page(
            "<p>contact@cabinet-dupont.fr</p>",
          ),
        });
        const result = await search(deps);
        expect(result.status).toBe("blocked");
        expect(pagesOf(calls).map((call) => call.url)).toEqual([
          HOME,
          "https://www.cabinet-dupont.fr/contact",
        ]);
      },
    );

    it("s'arrête sur une erreur serveur", async () => {
      const { deps } = harness({ [HOME]: { status: 500, body: "erreur" } });
      expect((await search(deps)).status).toBe("unreachable");
    });

    it("s'arrête sur un captcha ou un défi anti-robot et ne retient rien de la page", async () => {
      const { deps } = harness({
        [HOME]: page(
          "<html><head><title>Just a moment...</title></head><body>contact@cabinet-dupont.fr</body></html>",
        ),
      });
      const result = await search(deps);
      expect(result.status).toBe("blocked");
      expect(result.email).toBeUndefined();
    });
  });

  describe("choix de l'adresse", () => {
    it("ambiguïté : rien n'est retenu", async () => {
      const { calls, deps } = harness({
        [HOME]: page(
          '<a href="/contact">Contact</a><p>marie.martin@cabinet-dupont.fr paul.durand@cabinet-dupont.fr</p>',
        ),
        "https://www.cabinet-dupont.fr/contact": page(
          "<p>contact@cabinet-dupont.fr cabinet@cabinet-dupont.fr</p>",
        ),
      });
      const result = await search(deps);
      expect(result.status).toBe("ambiguous");
      expect(result.email).toBeUndefined();
      expect(pagesOf(calls)).toHaveLength(2);
    });

    it("les adresses exclues ne sont jamais retenues", async () => {
      const { deps } = harness({
        [HOME]: page(
          "<p>greffe@tj-bordeaux.justice.fr, me.dupont@avocat-conseil.fr, carpa@cabinet-dupont.fr, noreply@cabinet-dupont.fr</p>",
        ),
      });
      expect((await search(deps)).status).toBe("none");
    });

    it("ne décode pas une adresse masquée par Cloudflare", async () => {
      const { deps } = harness({
        [HOME]: page(
          '<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="0a69">[email&#160;protected]</a>',
        ),
      });
      expect((await search(deps)).status).toBe("none");
    });
  });

  describe("protection du réseau interne", () => {
    it.each([
      ["http://www.cabinet-dupont.fr/", "http"],
      ["https://127.0.0.1/", "adresse IP"],
      ["https://www.cabinet-dupont.fr:8443/", "port"],
      ["https://user:pass@www.cabinet-dupont.fr/", "identifiants"],
      ["https://www.linkedin.com/in/dupont", "hôte exclu"],
    ])("refuse l'URL de départ %s (%s)", async (startUrl) => {
      const { calls, deps } = harness({});
      expect((await search(deps, { startUrl })).status).toBe("invalid_url");
      expect(calls).toEqual([]);
    });

    it("refuse un domaine qui se résout vers un réseau privé", async () => {
      const { calls, deps } = harness(
        { [HOME]: page("<p>contact@cabinet-dupont.fr</p>") },
        { lookupImpl: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }] },
      );
      const result = await search(deps);
      expect(result.status).toBe("robots_unreadable");
      expect(calls).toEqual([]);
    });

    it("reconnaît les adresses privées, locales et réservées", () => {
      for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fd00::1",
        "::ffff:127.0.0.1",
      ]) {
        expect(isPrivateNetworkAddress(address), address).toBe(true);
      }
      for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) {
        expect(isPrivateNetworkAddress(address), address).toBe(false);
      }
    });
  });

  it("respecte le budget de temps global", async () => {
    let clock = 0;
    const { calls, deps } = harness(
      { [HOME]: page('<a href="/contact">Contact</a>') },
      {
        now: () => clock,
        sleep: async () => undefined,
      },
    );
    const original = deps.fetchImpl!;
    deps.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      clock += 6_000;
      return original(...args);
    }) as typeof fetch;
    const result = await search(deps, { budgetMs: 10_000 });
    expect(result.status).toBe("budget");
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("espace les requêtes d'une pause (sans dépasser le budget)", async () => {
    const waits: number[] = [];
    const { deps } = harness(
      {
        [HOME]: page('<a href="/contact">Contact</a>'),
        "https://www.cabinet-dupont.fr/contact": page("<p>rien</p>"),
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    await search(deps, { pauseMs: 400 });
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(400);
  });
});
