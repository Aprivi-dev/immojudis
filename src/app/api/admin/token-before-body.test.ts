import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@/lib/api-errors";

// Toute lecture de la base par le client de service, avant ou à la place de la garde, fait échouer
// le test : la réponse attendue (401, 403, 400) ne peut venir que de la garde ou de la validation.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`supabaseAdmin.${String(property)} lu avant la garde administrateur`);
      },
    },
  ),
}));

/**
 * Jetons des tests : « jeton-admin » (administrateur), « jeton-utilisateur » (compte ordinaire),
 * tout autre jeton est refusé par Supabase. La lecture de l'en-tête reste la vraie.
 */
vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: async (token: string) => {
    if (token !== "jeton-admin" && token !== "jeton-utilisateur") {
      throw new AuthRequiredError("Unauthorized: Invalid token");
    }
    const isAdmin = token === "jeton-admin";
    return {
      supabase: {},
      userId: "00000000-0000-4000-8000-000000000001",
      claims: { sub: "00000000-0000-4000-8000-000000000001" },
      accountTier: "free",
      userRole: isAdmin ? "admin" : "user",
      isAdmin,
    };
  },
}));

/**
 * Revue du 28/10/2026 (n° 6), puis audit de l'administration du 14/11/2026 (D1, D8) : une route
 * admin contrôle le jeton PUIS le rôle administrateur AVANT de lire ou de valider le corps et les
 * paramètres. Un visiteur sans session valide reçoit 401, un compte ordinaire 403, quel que soit
 * ce qu'il envoie : il n'apprend rien du format attendu (les erreurs de validation en disent long)
 * et la route ne lit pas une requête qu'il n'a pas le droit d'envoyer.
 */
type Case = {
  name: string;
  load: () => Promise<Record<string, unknown>>;
  method: "GET" | "POST" | "PATCH";
  /** Paramètres invalides d'une lecture. */
  query?: string;
  /** Corps invalide d'une écriture (par défaut, un objet sans aucun champ attendu). */
  body?: unknown;
};

const INVALID_BODY = { n: "importe quoi" };

const ROUTES: Case[] = [
  {
    name: "catalogue-readiness (lecture)",
    load: () => import("./catalogue-readiness/route"),
    method: "GET",
    query: "limit=0",
  },
  {
    name: "catalogue-readiness",
    load: () => import("./catalogue-readiness/route"),
    method: "PATCH",
  },
  { name: "dashboard", load: () => import("./dashboard/route"), method: "GET", query: "section=x" },
  {
    name: "fact-claims/review (lecture)",
    load: () => import("./fact-claims/review/route"),
    method: "GET",
    query: "limit=0",
  },
  { name: "fact-claims/review", load: () => import("./fact-claims/review/route"), method: "POST" },
  {
    name: "information-agent (lecture)",
    load: () => import("./information-agent/route"),
    method: "GET",
    query: "limit=0",
  },
  {
    name: "information-agent (relecture)",
    load: () => import("./information-agent/route"),
    method: "PATCH",
  },
  {
    name: "information-agent (réponse reçue)",
    load: () => import("./information-agent/route"),
    method: "POST",
  },
  {
    name: "information-agent/auto-publication",
    load: () => import("./information-agent/auto-publication/route"),
    method: "POST",
  },
  {
    name: "information-agent/autopilot",
    load: () => import("./information-agent/autopilot/route"),
    method: "POST",
  },
  {
    name: "information-agent/missions (lecture)",
    load: () => import("./information-agent/missions/route"),
    method: "GET",
    query: "saleId=x",
  },
  {
    name: "information-agent/missions (création)",
    load: () => import("./information-agent/missions/route"),
    method: "POST",
  },
  {
    name: "information-agent/missions (action)",
    load: () => import("./information-agent/missions/route"),
    method: "PATCH",
  },
  {
    name: "information-agent/missions/prepare",
    load: () => import("./information-agent/missions/prepare/route"),
    method: "POST",
  },
  {
    name: "information-agent/missions/preview",
    load: () => import("./information-agent/missions/preview/route"),
    method: "POST",
  },
  {
    name: "information-agent/source-refresh (lecture)",
    load: () => import("./information-agent/source-refresh/route"),
    method: "GET",
    query: "saleId=x",
  },
  {
    name: "information-agent/source-refresh",
    load: () => import("./information-agent/source-refresh/route"),
    method: "POST",
  },
  {
    name: "information-agent/template",
    load: () => import("./information-agent/template/route"),
    method: "POST",
  },
  {
    name: "information-agent/unrouted (lecture)",
    load: () => import("./information-agent/unrouted/route"),
    method: "GET",
    query: "limit=0",
  },
  {
    name: "information-agent/unrouted",
    load: () => import("./information-agent/unrouted/route"),
    method: "POST",
  },
  { name: "launch-offer", load: () => import("./launch-offer/route"), method: "POST" },
  {
    name: "lawyer-referrals (lecture)",
    load: () => import("./lawyer-referrals/route"),
    method: "GET",
    query: "limit=0",
  },
  { name: "lawyer-referrals", load: () => import("./lawyer-referrals/route"), method: "PATCH" },
  { name: "lawyers", load: () => import("./lawyers/route"), method: "POST" },
  {
    name: "lawyers/statement",
    load: () => import("./lawyers/statement/route"),
    method: "GET",
    query: "month=x",
  },
  {
    name: "offer-opening-notifier",
    load: () => import("./offer-opening-notifier/route"),
    method: "POST",
  },
  { name: "pepites", load: () => import("./pepites/route"), method: "POST" },
  {
    name: "privacy-requests (lecture)",
    load: () => import("./privacy-requests/route"),
    method: "GET",
    query: "limit=0",
  },
  {
    name: "privacy-requests (mise à jour)",
    load: () => import("./privacy-requests/route"),
    method: "PATCH",
  },
  {
    name: "privacy-requests (effacement)",
    load: () => import("./privacy-requests/route"),
    method: "POST",
  },
  {
    name: "privacy-requests/professional-export",
    load: () => import("./privacy-requests/professional-export/route"),
    method: "GET",
    query: "requestId=x",
  },
  {
    name: "privacy-requests/withdrawal",
    load: () => import("./privacy-requests/withdrawal/route"),
    method: "POST",
  },
  {
    name: "publications (lecture)",
    load: () => import("./publications/route"),
    method: "GET",
    query: "limit=0",
  },
  { name: "publications", load: () => import("./publications/route"), method: "PATCH" },
  { name: "scroll", load: () => import("./scroll/route"), method: "POST" },
  { name: "signups", load: () => import("./signups/route"), method: "POST" },
  {
    name: "signups/search",
    load: () => import("./signups/search/route"),
    method: "POST",
    body: { limit: 0 },
  },
  {
    name: "subscriptions (lecture)",
    load: () => import("./subscriptions/route"),
    method: "GET",
    query: "limit=0",
  },
  { name: "subscriptions", load: () => import("./subscriptions/route"), method: "POST" },
];

async function send(route: Case, token: string | null): Promise<Response> {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const handler = (await route.load())[route.method] as (request: Request) => Promise<Response>;
  expect(handler, `${route.name}: ${route.method} manquant`).toBeTypeOf("function");
  const path = route.name.replace(/ \(.*\)$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return handler(
    new Request(
      `https://example.test/api/admin/${path}${route.query ? `?${route.query}` : ""}`,
      route.method === "GET"
        ? { headers }
        : { method: route.method, headers, body: JSON.stringify(route.body ?? INVALID_BODY) },
    ),
  );
}

describe("routes admin : le jeton et le rôle avant le corps et les paramètres", () => {
  it.each(ROUTES.map((route) => [route.name, route.method, route] as const))(
    "%s (%s) refuse en 401 une requête invalide sans jeton",
    async (_name, _method, route) => {
      expect((await send(route, null)).status).toBe(401);
    },
  );

  it.each(ROUTES.map((route) => [route.name, route.method, route] as const))(
    "%s (%s) refuse en 401 une requête invalide avec un jeton refusé",
    async (_name, _method, route) => {
      expect((await send(route, "jeton-falsifie")).status).toBe(401);
    },
  );

  it.each(ROUTES.map((route) => [route.name, route.method, route] as const))(
    "%s (%s) refuse en 403 une requête invalide d'un compte non administrateur",
    async (_name, _method, route) => {
      expect((await send(route, "jeton-utilisateur")).status).toBe(403);
    },
  );

  // Témoin : la requête de ces cas est bien invalide (un administrateur reçoit 400). Sans lui, un
  // 403 pourrait venir d'une requête valide refusée plus loin, et ne prouverait pas l'ordre.
  it.each(ROUTES.map((route) => [route.name, route.method, route] as const))(
    "%s (%s) : la même requête d'un administrateur est refusée en 400",
    async (_name, _method, route) => {
      expect((await send(route, "jeton-admin")).status).toBe(400);
    },
  );
});

/**
 * Relecture de sécurité de la PR #502 : la liste ci-dessus est fixe. Ici, chaque `route.ts` du
 * dossier est trouvé par lecture du disque et chaque méthode HTTP qu'il exporte est appelée sans
 * jeton, avec un jeton refusé et avec un compte ordinaire. Une nouvelle route ou une nouvelle
 * méthode est donc couverte sans qu'on pense à l'ajouter.
 */
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ADMIN_DIRECTORY = join(process.cwd(), "src", "app", "api", "admin");

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

const DISCOVERED = routeFiles(ADMIN_DIRECTORY).map((file) => ({
  file,
  path: relative(ADMIN_DIRECTORY, file).split(sep).slice(0, -1).join("/"),
}));

async function discoveredHandlers() {
  const handlers: Array<{
    name: string;
    method: string;
    path: string;
    handler: (
      request: Request,
      context: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;
  }> = [];
  for (const { file, path } of DISCOVERED) {
    const module = (await import(file)) as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      if (typeof module[method] !== "function") continue;
      handlers.push({
        name: `${path} ${method}`,
        method,
        path,
        handler: module[method] as (typeof handlers)[number]["handler"],
      });
    }
  }
  return handlers;
}

async function call(
  { method, path, handler }: Awaited<ReturnType<typeof discoveredHandlers>>[number],
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // Segments dynamiques (`[id]`) : une valeur quelconque, que la garde doit refuser avant de lire.
  const params = Object.fromEntries(
    [...path.matchAll(/\[([^\]]+)\]/g)].map(([, name]) => [name, "x"]),
  );
  const url = `https://example.test/api/admin/${path.replace(/\[([^\]]+)\]/g, "x")}?n=1`;
  const hasBody = method !== "GET" && method !== "HEAD";
  return handler(
    new Request(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(INVALID_BODY) : undefined,
    }),
    { params: Promise.resolve(params) },
  );
}

describe("toutes les routes admin trouvées sur le disque : la garde avant tout", () => {
  it("trouve les routes et leurs méthodes", async () => {
    expect(DISCOVERED.length).toBeGreaterThanOrEqual(40);
    expect((await discoveredHandlers()).length).toBeGreaterThanOrEqual(60);
  });

  it("chaque méthode refuse 401 sans jeton, 401 avec un jeton refusé, 403 pour un compte ordinaire", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const statuses: Record<string, number[]> = {};
    for (const route of await discoveredHandlers()) {
      statuses[route.name] = [
        (await call(route, null)).status,
        (await call(route, "jeton-falsifie")).status,
        (await call(route, "jeton-utilisateur")).status,
      ];
    }
    const unexpected = Object.entries(statuses).filter(
      ([, [none, refused, ordinary]]) => none !== 401 || refused !== 401 || ordinary !== 403,
    );
    expect(unexpected).toEqual([]);
  });
});
