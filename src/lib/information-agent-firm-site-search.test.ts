import { describe, expect, it, vi } from "vitest";
import {
  createHttpsTransport,
  createPublicOnlyLookup,
  FIRM_SITE_MAX_PAGES,
  FIRM_SITE_MAX_REQUESTS,
  informationAgentSearchUserAgent,
  isPrivateNetworkAddress,
  searchFirmWebsiteAddress,
  type FirmSiteSearchDeps,
  type FirmSiteTransportRequest,
  type FirmSiteTransportResponse,
} from "@/lib/information-agent/firm-site-search";

/**
 * Aucune requête réseau réelle : le transport est simulé. Chaque test vérifie aussi les requêtes
 * émises (domaine, nombre, user-agent, plafonds).
 */

type Route = {
  status?: number;
  body?: string;
  type?: string;
  location?: string;
  truncated?: boolean;
};

const HOME = "https://www.cabinet-dupont.fr/";
const USER_AGENT = informationAgentSearchUserAgent("https://immojudis.com");

function page(body: string, extra: Route = {}): Route {
  return { status: 200, type: "text/html; charset=utf-8", body, ...extra };
}

function harness(routes: Record<string, Route>, overrides: Partial<FirmSiteSearchDeps> = {}) {
  const calls: Array<{ url: string; userAgent: string | undefined; dnsTimeoutMs: number }> = [];
  const transport = vi.fn(
    async (request: FirmSiteTransportRequest): Promise<FirmSiteTransportResponse> => {
      const url = request.url.toString();
      calls.push({
        url,
        userAgent: request.headers["user-agent"],
        dnsTimeoutMs: request.dnsTimeoutMs,
      });
      const route = routes[url];
      if (!route) {
        return {
          status: 404,
          location: null,
          contentType: "text/html",
          body: "",
          truncated: false,
        };
      }
      return {
        status: route.status ?? 200,
        location: route.location ?? null,
        contentType: route.type ?? (url.endsWith("/robots.txt") ? "text/plain" : "text/html"),
        body: route.body ?? "",
        truncated: route.truncated ?? false,
      };
    },
  );
  const deps: FirmSiteSearchDeps = { transport, sleep: async () => undefined, ...overrides };
  return { calls, deps, transport };
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
  it("retient l'adresse publiée, avec un user-agent qui identifie Immojudis", async () => {
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
      reason: "generic",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.cabinet-dupont.fr/robots.txt",
      HOME,
    ]);
    expect(USER_AGENT).toBe("ImmojudisAdresses/1.0 (+https://immojudis.com/contact)");
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
    expect(pagesOf(calls).map((call) => call.url)).toEqual([
      HOME,
      "https://www.cabinet-dupont.fr/contact",
      "https://www.cabinet-dupont.fr/mentions-legales",
    ]);
  });

  it("s'arrête après la page de départ seulement sur une correspondance forte (nom et prénom)", async () => {
    const { calls, deps } = harness({
      [HOME]: page('<a href="/contact">Contact</a><p>jean.dupont@cabinet-dupont.fr</p>'),
      "https://www.cabinet-dupont.fr/contact": page("<p>autre@cabinet-dupont.fr</p>"),
    });
    const result = await search(deps);
    expect(result).toMatchObject({
      status: "found",
      email: "jean.dupont@cabinet-dupont.fr",
      reason: "name",
      pagesFetched: 1,
    });
    expect(pagesOf(calls)).toHaveLength(1);
  });

  it("lit aussi contact et mentions légales quand la page de départ ne donne qu'une adresse générique", async () => {
    const { calls, deps } = harness({
      [HOME]: page('<a href="/contact">Contact</a><p>cabinet@cabinet-dupont.fr</p>'),
      "https://www.cabinet-dupont.fr/contact": page("<p>cabinet@cabinet-dupont.fr</p>"),
    });
    const result = await search(deps);
    expect(result).toMatchObject({ status: "found", email: "cabinet@cabinet-dupont.fr" });
    expect(result.pagesFetched).toBe(2);
    expect(pagesOf(calls)).toHaveLength(2);

    // La page de contact révèle une seconde adresse générique : ambiguïté, rien n'est retenu.
    const ambiguous = harness({
      [HOME]: page('<a href="/contact">Contact</a><p>cabinet@cabinet-dupont.fr</p>'),
      "https://www.cabinet-dupont.fr/contact": page("<p>contact@cabinet-dupont.fr</p>"),
    });
    const second = await search(ambiguous.deps);
    expect(second.status).toBe("ambiguous");
    expect(second.email).toBeUndefined();
  });

  it("n'envoie aucune requête hors du domaine, même par lien ou par redirection", async () => {
    const { calls, deps } = harness({
      [HOME]: page(
        '<a href="https://www.linkedin.com/in/dupont">Contact</a><a href="https://autre.example/contact">Contact</a><a href="/mentions-legales">Mentions légales</a>',
      ),
      "https://www.cabinet-dupont.fr/mentions-legales": {
        status: 302,
        location: "https://evil.example/contact",
      },
    });
    const result = await search(deps);

    expect(result.status).toBe("none");
    const hosts = new Set(calls.map((call) => new URL(call.url).hostname));
    expect([...hosts]).toEqual(["www.cabinet-dupont.fr"]);
  });

  it("suit une redirection du même site (apex vers www) mais pas un retour en clair", async () => {
    const { calls, deps } = harness({
      "https://cabinet-dupont.fr/robots.txt": { status: 404 },
      "https://cabinet-dupont.fr/": { status: 301, location: "https://www.cabinet-dupont.fr/" },
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
      "https://cabinet-dupont.fr/": { status: 301, location: "http://cabinet-dupont.fr/" },
    });
    expect((await search(downgraded.deps, { startUrl: "https://cabinet-dupont.fr/" })).status).toBe(
      "unreachable",
    );
    expect(downgraded.calls.map((call) => call.url)).not.toContain("http://cabinet-dupont.fr/");
  });

  it("au-delà de 2 redirections, ou en boucle A → B → A, la page est abandonnée", async () => {
    const chain = harness({
      [HOME]: page('<a href="/contact">Contact</a>'),
      "https://www.cabinet-dupont.fr/contact": { status: 302, location: "/a" },
      "https://www.cabinet-dupont.fr/a": { status: 302, location: "/b" },
      "https://www.cabinet-dupont.fr/b": { status: 302, location: "/c" },
      "https://www.cabinet-dupont.fr/c": page("<p>contact@cabinet-dupont.fr</p>"),
    });
    const result = await search(chain.deps);
    expect(result.status).toBe("none");
    expect(chain.calls.map((call) => call.url)).not.toContain("https://www.cabinet-dupont.fr/c");

    const loop = harness({
      [HOME]: page('<a href="/contact">Contact</a>'),
      "https://www.cabinet-dupont.fr/contact": { status: 302, location: "/mentions" },
      "https://www.cabinet-dupont.fr/mentions": { status: 302, location: "/contact" },
    });
    expect((await search(loop.deps)).status).toBe("none");
    // robots.txt, la page de départ, puis au plus 3 requêtes pour la boucle.
    expect(loop.calls.length).toBeLessThanOrEqual(5);
  });

  it(`plafonne le nombre total de requêtes (redirections comprises) à ${FIRM_SITE_MAX_REQUESTS}`, async () => {
    const routes: Record<string, Route> = {
      [HOME]: page('<a href="/contact">C</a><a href="/mentions-legales">M</a>'),
    };
    for (const path of ["contact", "mentions-legales"]) {
      routes[`https://www.cabinet-dupont.fr/${path}`] = { status: 302, location: `/${path}-1` };
      routes[`https://www.cabinet-dupont.fr/${path}-1`] = { status: 302, location: `/${path}-2` };
      routes[`https://www.cabinet-dupont.fr/${path}-2`] = page("<p>rien</p>");
    }
    const { calls, deps } = harness(routes);
    await search(deps);
    expect(calls.length).toBeLessThanOrEqual(FIRM_SITE_MAX_REQUESTS);
  });

  it("traite `cabinet.fr.` (point final) comme le même hôte, sans requête ailleurs", async () => {
    const { calls, deps } = harness({
      "https://www.cabinet-dupont.fr/robots.txt": { status: 404 },
      [HOME]: page(
        '<a href="https://www.cabinet-dupont.fr./contact">Contact</a><p>contact@cabinet-dupont.fr</p>',
      ),
      "https://www.cabinet-dupont.fr/contact": page("<p>contact@cabinet-dupont.fr</p>"),
    });
    const result = await search(deps, { startUrl: "https://www.cabinet-dupont.fr./" });
    expect(result).toMatchObject({ status: "found", email: "contact@cabinet-dupont.fr" });
    expect(new Set(calls.map((call) => new URL(call.url).hostname))).toEqual(
      new Set(["www.cabinet-dupont.fr"]),
    );
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
        "https://www.cabinet-dupont.fr/contact": { status: 302, location: "/prive/contact" },
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
      ["redirection hors domaine", { status: 301, location: "https://autre.example/robots.txt" }],
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
      const transport = vi.fn(async (request: FirmSiteTransportRequest) => {
        calls.push(request.url.toString());
        throw new DOMException("délai dépassé", "TimeoutError");
      });
      const result = await search({ transport, sleep: async () => undefined });
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

    it("un fichier démesuré (plus de 1000 règles) est refusé en bloc", async () => {
      const rules = Array.from({ length: 1001 }, (_, i) => `Disallow: /x${i}`).join("\n");
      const { calls, deps } = harness({
        "https://www.cabinet-dupont.fr/robots.txt": { body: `User-agent: *\n${rules}` },
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

  describe("contenu des pages", () => {
    it.each([
      ["un PDF", "application/pdf"],
      ["une image", "image/png"],
      ["du JSON", "application/json"],
      ["du texte brut", "text/plain"],
    ])("ne lit pas %s comme une page", async (_label, type) => {
      const { deps } = harness({
        [HOME]: { status: 200, type, body: "contact@cabinet-dupont.fr" },
      });
      const result = await search(deps);
      expect(result.status).toBe("unreachable");
      expect(result.email).toBeUndefined();
    });

    it("ôte le dernier mot d'un contenu coupé à 1 Mio (adresse peut-être incomplète)", async () => {
      const cut = harness({
        [HOME]: page("<p>Écrire à marie.martin@cabinet-dupont.fr ou à contact@cabinet-dupont.fr", {
          truncated: true,
        }),
      });
      // Sans le dernier mot, seule l'adresse nominative d'une autre personne reste : ambiguïté.
      expect((await search(cut.deps)).status).toBe("ambiguous");

      const whole = harness({
        [HOME]: page("<p>Écrire à marie.martin@cabinet-dupont.fr ou à contact@cabinet-dupont.fr"),
      });
      expect(await search(whole.deps)).toMatchObject({
        status: "found",
        email: "contact@cabinet-dupont.fr",
      });
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

    it("n'admet ni adresse hors du domaine du site ni adresse du domaine parent", async () => {
      const outside = harness({
        [HOME]: page("<p>jean.dupont@gmail.com contact@agence-web.fr</p>"),
      });
      expect((await search(outside.deps)).status).toBe("none");

      const blog = harness({
        "https://cabinet.over-blog.com/": page(
          "<p>contact@over-blog.com jean.dupont@over-blog.com</p>",
        ),
      });
      expect((await search(blog.deps, { startUrl: "https://cabinet.over-blog.com/" })).status).toBe(
        "none",
      );
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

    it.each([
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fec0::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::7f00:1",
      "2002:7f00:1::",
      "2002:c0a8:1::1",
      "2001:db8::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "64:ff9b::7f00:1",
      "192.0.2.1",
      "192.0.0.8",
      "198.51.100.7",
      "203.0.113.9",
      "192.88.99.1",
      "3fff::1",
      "3fff:fff:ffff::1",
      "2001:2::1",
      "2001:10::1",
      "2001:1ff:ffff::1",
    ])("%s n'est pas une adresse publique", (address) => {
      expect(isPrivateNetworkAddress(address)).toBe(true);
    });

    it.each([
      "93.184.216.34",
      "8.8.8.8",
      "192.0.3.1",
      "198.51.101.1",
      "203.0.114.1",
      "2606:4700:4700::1111",
      "2a00:1450:4007:80f::200e",
      "2001:200::1",
      "3fff:1000::1",
    ])("%s est une adresse publique", (address) => {
      expect(isPrivateNetworkAddress(address)).toBe(false);
    });

    it("la résolution DNS est contrôlée à chaque connexion : une IP privée rendue après coup est refusée", async () => {
      // Premier appel : adresse publique ; second appel (la connexion) : réécriture vers 127.0.0.1.
      const lookupImpl = vi
        .fn()
        .mockResolvedValueOnce([{ address: "93.184.216.34" }])
        .mockResolvedValue([{ address: "127.0.0.1" }]);
      const lookup = createPublicOnlyLookup(lookupImpl);
      const resolve = (all: boolean) =>
        new Promise<unknown[]>((done) =>
          lookup(
            "www.cabinet-dupont.fr",
            { all } as never,
            ((...args: unknown[]) => done(args)) as never,
          ),
        );
      expect(await resolve(false)).toEqual([null, "93.184.216.34", 4]);
      const [error] = await resolve(false);
      expect(error).toMatchObject({ code: "EPRIVATEADDRESS" });
      const [allError] = await resolve(true);
      expect(allError).toMatchObject({ code: "EPRIVATEADDRESS" });
    });

    it("refuse l'ensemble des adresses dès que l'une n'est pas publique, et rend la liste contrôlée", async () => {
      const mixed = createPublicOnlyLookup(async () => [
        { address: "93.184.216.34" },
        { address: "10.0.0.5" },
      ]);
      const [error] = await new Promise<unknown[]>((done) =>
        mixed("a.fr", { all: true } as never, ((...args: unknown[]) => done(args)) as never),
      );
      expect(error).toMatchObject({ code: "EPRIVATEADDRESS" });

      const safe = createPublicOnlyLookup(async () => [
        { address: "93.184.216.34" },
        { address: "2606:4700:4700::1111" },
      ]);
      const result = await new Promise<unknown[]>((done) =>
        safe("a.fr", { all: true } as never, ((...args: unknown[]) => done(args)) as never),
      );
      expect(result).toEqual([
        null,
        [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:4700:4700::1111", family: 6 },
        ],
      ]);
    });

    it("le lookup respecte la famille demandée, après contrôle de toutes les adresses", async () => {
      const lookupImpl = async () => [
        { address: "93.184.216.34" },
        { address: "2606:4700:4700::1111" },
      ];
      const ask = (options: unknown) =>
        new Promise<unknown[]>((done) =>
          createPublicOnlyLookup(lookupImpl)(
            "a.fr",
            options as never,
            ((...args: unknown[]) => done(args)) as never,
          ),
        );
      expect(await ask({ family: 4, all: true })).toEqual([
        null,
        [{ address: "93.184.216.34", family: 4 }],
      ]);
      expect(await ask({ family: 6, all: true })).toEqual([
        null,
        [{ address: "2606:4700:4700::1111", family: 6 }],
      ]);
      expect(await ask({ family: "IPv6" })).toEqual([null, "2606:4700:4700::1111", 6]);
      expect(await ask({ family: 0, all: true })).toEqual([
        null,
        [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:4700:4700::1111", family: 6 },
        ],
      ]);
      expect(await ask(4)).toEqual([null, "93.184.216.34", 4]);

      // Aucune adresse de la famille demandée : refus, sans repli sur l'autre famille.
      const onlyV4 = createPublicOnlyLookup(async () => [{ address: "93.184.216.34" }]);
      const [error] = await new Promise<unknown[]>((done) =>
        onlyV4("a.fr", { family: 6 } as never, ((...args: unknown[]) => done(args)) as never),
      );
      expect(error).toMatchObject({ code: "ENOTFOUND" });

      // Une adresse privée de l'autre famille refuse tout, même si la famille demandée est publique.
      const mixed = createPublicOnlyLookup(async () => [
        { address: "93.184.216.34" },
        { address: "fd00::1" },
      ]);
      const [privateError] = await new Promise<unknown[]>((done) =>
        mixed("a.fr", { family: 4 } as never, ((...args: unknown[]) => done(args)) as never),
      );
      expect(privateError).toMatchObject({ code: "EPRIVATEADDRESS" });
    });

    it("le transport réel refuse toute adresse IP littérale, IPv4 ou IPv6", async () => {
      const lookupImpl = vi.fn(async () => [{ address: "93.184.216.34" }]);
      const transport = createHttpsTransport({ lookupImpl });
      for (const url of [
        "https://93.184.216.34/robots.txt",
        "https://[2606:4700:4700::1111]/robots.txt",
        "https://127.0.0.1/",
      ]) {
        await expect(
          transport({
            url: new URL(url),
            headers: {},
            signal: AbortSignal.timeout(2000),
            maxBytes: 1024,
            dnsTimeoutMs: 1000,
          }),
        ).rejects.toThrow("IP littérale");
      }
      expect(lookupImpl).not.toHaveBeenCalled();
    });

    it("la résolution DNS est bornée dans le temps", async () => {
      const slow = createPublicOnlyLookup(() => new Promise(() => undefined), 20);
      const [error] = await new Promise<unknown[]>((done) =>
        slow("a.fr", {} as never, ((...args: unknown[]) => done(args)) as never),
      );
      expect(error).toMatchObject({ code: "EDNSTIMEOUT" });
    });

    it("le transport réel ne se connecte pas à un hôte résolu vers un réseau privé", async () => {
      const transport = createHttpsTransport({
        lookupImpl: async () => [{ address: "10.0.0.5" }],
      });
      await expect(
        transport({
          url: new URL("https://www.cabinet-dupont.fr/robots.txt"),
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(2000),
          maxBytes: 1024,
          dnsTimeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ code: "EPRIVATEADDRESS" });
    });

    it("la recherche traite un hôte refusé par le transport comme injoignable", async () => {
      const transport = createHttpsTransport({
        lookupImpl: async () => [{ address: "127.0.0.1" }],
      });
      const result = await search({ transport, sleep: async () => undefined });
      expect(result.status).toBe("robots_unreadable");
    });
  });

  describe("temps et abandon", () => {
    it("respecte le budget de temps global", async () => {
      let clock = 0;
      const { calls, deps } = harness(
        { [HOME]: page('<a href="/contact">Contact</a>') },
        { now: () => clock },
      );
      const inner = deps.transport!;
      deps.transport = async (request) => {
        clock += 6_000;
        return inner(request);
      };
      const result = await search(deps, { budgetMs: 10_000 });
      expect(result.status).toBe("budget");
      expect(calls.length).toBeLessThanOrEqual(2);
    });

    it("borne la résolution DNS par le budget restant (3 s au plus)", async () => {
      const { calls, deps } = harness({ [HOME]: page("<p>contact@cabinet-dupont.fr</p>") });
      await search(deps, { budgetMs: 1_000 });
      for (const call of calls) expect(call.dnsTimeoutMs).toBeLessThanOrEqual(1_000);
      const wide = harness({ [HOME]: page("<p>contact@cabinet-dupont.fr</p>") });
      await search(wide.deps, { budgetMs: 15_000 });
      for (const call of wide.calls) expect(call.dnsTimeoutMs).toBeLessThanOrEqual(3_000);
    });

    it("abandonne réellement une requête bloquée (signal abandonné, même si le transport l'ignore)", async () => {
      const signals: AbortSignal[] = [];
      const transport = vi.fn((request: FirmSiteTransportRequest) => {
        signals.push(request.signal);
        return new Promise<FirmSiteTransportResponse>(() => undefined);
      });
      const started = Date.now();
      const result = await search(
        { transport, sleep: async () => undefined },
        { budgetMs: 2_000, requestTimeoutMs: 30 },
      );
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(result.status).toBe("robots_unreadable");
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    });

    it("abandonne la recherche quand le signal de la route admin est abandonné", async () => {
      const controller = new AbortController();
      const transport = vi.fn(() => new Promise<FirmSiteTransportResponse>(() => undefined));
      const pending = search(
        { transport, sleep: async () => undefined },
        { signal: controller.signal, budgetMs: 5_000, requestTimeoutMs: 4_000 },
      );
      setTimeout(() => controller.abort(new Error("délai de la route")), 20);
      const started = Date.now();
      const result = await pending;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(["budget", "robots_unreadable"]).toContain(result.status);
    });

    it("une requête qui échoue après son abandon ne laisse aucun rejet non traité", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const transport = vi.fn(
          () =>
            new Promise<FirmSiteTransportResponse>((_, reject) =>
              setTimeout(() => reject(new Error("échec tardif")), 80),
            ),
        );
        const result = await search(
          { transport, sleep: async () => undefined },
          { budgetMs: 2_000, requestTimeoutMs: 20 },
        );
        expect(result.status).toBe("robots_unreadable");
        await new Promise((done) => setTimeout(done, 200));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
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
});
