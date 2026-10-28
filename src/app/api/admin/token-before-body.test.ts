import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn(), auth: { admin: {} } },
}));

/**
 * Revue du 28/10/2026 (n° 6) : une route admin lit le jeton AVANT de valider le corps. Sans jeton, un visiteur
 * reçoit 401 quel que soit son corps : il n'apprend rien du format attendu (les erreurs de validation en disent
 * long) et la route ne lit pas un corps qu'il n'a pas le droit d'envoyer.
 */
const ROUTES: Array<[string, () => Promise<Record<string, unknown>>, string]> = [
  ["launch-offer", () => import("./launch-offer/route"), "POST"],
  ["subscriptions", () => import("./subscriptions/route"), "POST"],
  ["catalogue-readiness", () => import("./catalogue-readiness/route"), "PATCH"],
  ["publications", () => import("./publications/route"), "PATCH"],
  ["lawyers", () => import("./lawyers/route"), "POST"],
  ["lawyer-referrals", () => import("./lawyer-referrals/route"), "PATCH"],
  ["information-agent (relecture)", () => import("./information-agent/route"), "PATCH"],
  ["information-agent (réponse reçue)", () => import("./information-agent/route"), "POST"],
  [
    "information-agent/missions (création)",
    () => import("./information-agent/missions/route"),
    "POST",
  ],
  [
    "information-agent/missions (action)",
    () => import("./information-agent/missions/route"),
    "PATCH",
  ],
  [
    "information-agent/missions/preview",
    () => import("./information-agent/missions/preview/route"),
    "POST",
  ],
  ["information-agent/template", () => import("./information-agent/template/route"), "POST"],
];

describe("routes admin : le jeton avant le corps", () => {
  it.each(ROUTES)("%s refuse en 401 un corps invalide sans jeton", async (name, load, method) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = (await load())[method] as (request: Request) => Promise<Response>;
    expect(handler, `${name}: ${method} manquant`).toBeTypeOf("function");

    const response = await handler(
      new Request(`https://example.test/api/admin/${name}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: "importe quoi" }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
