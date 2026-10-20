import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";
import { classifyApiError, rateLimitResponse } from "@/lib/api-observability";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), record: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));

import { enforceDailyOperationLimits, enforceGlobalRateLimit } from "./rate-limit";
import {
  DAILY_LIMIT_MESSAGE,
  DAILY_OPERATION_LIMITS,
  DAILY_WINDOW_SECONDS,
  DATA_REFRESH_GLOBAL_DAILY_LIMIT,
  DATA_REFRESH_IP_DAILY_LIMIT,
  DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT,
} from "./rate-limit-policies";

/** Compteur à fenêtre fixe commun aux trois RPC, comme les fonctions SQL. */
function installCounter() {
  const counts = new Map<string, number>();
  mocks.rpc.mockImplementation(
    async (
      name: string,
      args: { p_bucket_key: string; p_limit: number; p_user_id?: string; p_ip_hash?: string },
    ) => {
      const key = `${name}:${args.p_user_id ?? args.p_ip_hash}:${args.p_bucket_key}`;
      const next = (counts.get(key) ?? 0) + 1;
      if (next > args.p_limit) return { data: null, error: { message: "Rate limit exceeded." } };
      counts.set(key, next);
      return { data: next, error: null };
    },
  );
}

const requestFrom = (ip: string) =>
  new Request("https://immojudis.com/api/x", { headers: { "x-real-ip": ip } });

describe("plafonds journaliers des opérations coûteuses", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.record.mockResolvedValue(true);
  });

  it("arrête un compte à son plafond journalier, avec le message quotidien et un 429", async () => {
    installCounter();
    const { perUser } = DAILY_OPERATION_LIMITS.propertyReportCreate;
    const request = requestFrom("198.51.100.1");
    for (let call = 0; call < perUser; call += 1) {
      await enforceDailyOperationLimits({
        request,
        userId: "user-1",
        operation: "propertyReportCreate",
      });
    }
    const failure = await enforceDailyOperationLimits({
      request,
      userId: "user-1",
      operation: "propertyReportCreate",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimitError);
    // Mesure par compte : un seul événement, au moment où le plafond est atteint.
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith("user-1", { type: "quota_reached", quota: "daily" });
    const error = failure as RateLimitError;
    expect(error.publicMessage).toBe("Limite quotidienne atteinte, réessayez demain.");
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(DAILY_WINDOW_SECONDS);
    // Rendu au client : 429 et message français sobre, pas le « Trop de demandes. » générique.
    expect(classifyApiError(error, { fallbackMessage: "x" })).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      message: DAILY_LIMIT_MESSAGE,
    });
  });

  it("empêche 50 comptes d'une même adresse de multiplier le plafond d'un compte", async () => {
    installCounter();
    const { perIp } = DAILY_OPERATION_LIMITS.propertyReportPdf;
    const request = requestFrom("198.51.100.2");
    let admitted = 0;
    let refused: unknown = null;
    for (let account = 0; account < 50 && !refused; account += 1) {
      for (let call = 0; call < 4 && !refused; call += 1) {
        try {
          await enforceDailyOperationLimits({
            request,
            userId: `user-${account}`,
            operation: "propertyReportPdf",
          });
          admitted += 1;
        } catch (error) {
          refused = error;
        }
      }
    }
    expect(admitted).toBe(perIp);
    expect(refused).toBeInstanceOf(RateLimitError);
    expect((refused as RateLimitError).publicMessage).toBe(DAILY_LIMIT_MESSAGE);
    // Une autre adresse n'est pas gênée.
    await expect(
      enforceDailyOperationLimits({
        request: requestFrom("198.51.100.3"),
        userId: "other-user",
        operation: "propertyReportPdf",
      }),
    ).resolves.toBeUndefined();
  });

  it("coupe tout le site au disjoncteur global, même depuis des adresses et des comptes différents", async () => {
    installCounter();
    const { global } = DAILY_OPERATION_LIMITS.landReport;
    for (let call = 0; call < global; call += 1) {
      await enforceDailyOperationLimits({
        request: requestFrom(`203.0.113.${call % 250}.${Math.floor(call / 250)}`),
        userId: `user-${call}`,
        operation: "landReport",
      });
    }
    await expect(
      enforceDailyOperationLimits({
        request: requestFrom("192.0.2.77"),
        userId: "brand-new-user",
        operation: "landReport",
      }),
    ).rejects.toMatchObject({ name: "RateLimitError", publicMessage: DAILY_LIMIT_MESSAGE });
  });

  it("garde un compteur global par opération et le tient en base avec une empreinte fixe", async () => {
    installCounter();
    await enforceDailyOperationLimits({
      request: requestFrom("198.51.100.4"),
      userId: "user-1",
      operation: "environmentContext",
    });
    const calls = mocks.rpc.mock.calls.map(([name, args]) => ({ name, ...args }));
    expect(calls.map((call) => call.p_bucket_key)).toEqual([
      "daily.environmentContext",
      "daily.environmentContext",
      "global.daily.environmentContext",
    ]);
    expect(calls[2].name).toBe("consume_ip_rate_limit");
    expect(calls[2].p_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[2].p_window_seconds).toBe(DAILY_WINDOW_SECONDS);
    expect(calls[2].p_limit).toBe(DAILY_OPERATION_LIMITS.environmentContext.global);
  });

  it("ne consomme ni l'adresse ni le disjoncteur global d'un compte déjà au plafond", async () => {
    installCounter();
    const { perUser } = DAILY_OPERATION_LIMITS.propertyReportCreate;
    const request = requestFrom("198.51.100.5");
    for (let call = 0; call < perUser; call += 1) {
      await enforceDailyOperationLimits({
        request,
        userId: "greedy",
        operation: "propertyReportCreate",
      });
    }
    mocks.rpc.mockClear();
    await expect(
      enforceDailyOperationLimits({ request, userId: "greedy", operation: "propertyReportCreate" }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("passe par le compteur de l'offre de lancement, avant le compteur global, pour ces comptes seuls", async () => {
    installCounter();
    await enforceDailyOperationLimits({
      request: requestFrom("198.51.100.8"),
      userId: "launch-user",
      operation: "apiKeyCreate",
      launchOffer: true,
    });
    await enforceDailyOperationLimits({
      request: requestFrom("198.51.100.9"),
      userId: "subscriber",
      operation: "apiKeyCreate",
    });
    const keys = mocks.rpc.mock.calls.map(([, args]) => args.p_bucket_key);
    expect(keys).toEqual([
      "daily.apiKeyCreate",
      "daily.apiKeyCreate",
      "global.daily.apiKeyCreate.launch-offer",
      "global.daily.apiKeyCreate",
      "daily.apiKeyCreate",
      "daily.apiKeyCreate",
      "global.daily.apiKeyCreate",
    ]);
    const launchCall = mocks.rpc.mock.calls[2][1];
    expect(launchCall.p_limit).toBe(DAILY_OPERATION_LIMITS.apiKeyCreate.launchOfferGlobal);
  });

  it("les comptes de l'offre de lancement n'épuisent pas la réserve des abonnés et des administrateurs", async () => {
    installCounter();
    const { launchOfferGlobal, global } = DAILY_OPERATION_LIMITS.lawyerReferralCreate;
    let launchAdmitted = 0;
    let refused: unknown = null;
    for (let account = 0; account < global && !refused; account += 1) {
      try {
        await enforceDailyOperationLimits({
          request: requestFrom(`10.${Math.floor(account / 250)}.0.${account % 250}`),
          userId: `launch-${account}`,
          operation: "lawyerReferralCreate",
          launchOffer: true,
        });
        launchAdmitted += 1;
      } catch (error) {
        refused = error;
      }
    }
    // L'offre s'arrête à sa part, avec le message quotidien.
    expect(launchAdmitted).toBe(launchOfferGlobal);
    expect(refused).toBeInstanceOf(RateLimitError);
    expect((refused as RateLimitError).publicMessage).toBe(DAILY_LIMIT_MESSAGE);

    // Les abonnés et administrateurs disposent du reste du plafond global.
    let reserveAdmitted = 0;
    for (let account = 0; account < global; account += 1) {
      try {
        await enforceDailyOperationLimits({
          request: requestFrom(`172.16.${Math.floor(account / 250)}.${account % 250}`),
          userId: `subscriber-${account}`,
          operation: "lawyerReferralCreate",
        });
        reserveAdmitted += 1;
      } catch {
        break;
      }
    }
    expect(reserveAdmitted).toBe(global - launchOfferGlobal);
  });

  it("échoue fermé quand le compteur global est indisponible (contrairement au limiteur par adresse)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    await expect(
      enforceGlobalRateLimit({ bucketKey: "k", limit: 5, windowSeconds: 60 }),
    ).rejects.toThrow("connection refused");
  });

  it("fait passer le message public dans la réponse 429 des routes qui répondent à la main", async () => {
    const response = rateLimitResponse(new RateLimitError(undefined, 30, DAILY_LIMIT_MESSAGE));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: DAILY_LIMIT_MESSAGE });
    const generic = rateLimitResponse(new RateLimitError());
    await expect(generic.json()).resolves.toMatchObject({ error: "Trop de demandes." });
  });
});

describe("seuils des plafonds journaliers", () => {
  it("restent cohérents : compte < adresse < site, et l'adresse laisse place à plusieurs comptes", () => {
    for (const limits of Object.values(DAILY_OPERATION_LIMITS)) {
      expect(limits.perUser).toBeGreaterThan(0);
      expect(limits.perIp).toBeGreaterThan(limits.perUser);
      expect(limits.global).toBeGreaterThan(limits.perIp);
      // La part de l'offre de lancement laisse une réserve aux abonnés et aux administrateurs.
      expect(limits.launchOfferGlobal).toBeGreaterThan(limits.perIp);
      expect(limits.launchOfferGlobal).toBeLessThan(limits.global);
    }
    expect(DAILY_LIMIT_MESSAGE).toBe("Limite quotidienne atteinte, réessayez demain.");
    expect(DATA_REFRESH_IP_DAILY_LIMIT).toBeGreaterThan(6);
  });

  it("couvre les opérations coûteuses ouvertes à tout compte confirmé", () => {
    expect(Object.keys(DAILY_OPERATION_LIMITS)).toEqual(
      expect.arrayContaining([
        "salesCsvExport",
        "salesApiFeed",
        "lawyerReferralCreate",
        "apiKeyCreate",
      ]),
    );
  });

  it("les plafonds globaux des actualisations sont ceux de la dernière migration SQL", () => {
    const sql = readFileSync(
      new URL(
        "../../supabase/migrations/20261029110100_launch_offer_separate_global_caps.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const global = /global_daily_limit constant integer := (\d+);/.exec(sql);
    const launch = /launch_offer_daily_limit constant integer := (\d+);/.exec(sql);
    expect(Number(global?.[1])).toBe(DATA_REFRESH_GLOBAL_DAILY_LIMIT);
    expect(Number(launch?.[1])).toBe(DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT);
    expect(DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT).toBeLessThan(DATA_REFRESH_GLOBAL_DAILY_LIMIT);
  });
});
