import { describe, expect, it, vi } from "vitest";
import { fetchResendDomains, fetchResendEmail, fetchResendWebhooks } from "./resend";

const KEY = "re_FACTICE_FACTICE";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchResendDomains", () => {
  it("ne contacte pas Resend sans clé", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchResendDomains(null, fetchImpl)).toEqual({
      ok: false,
      failure: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recopie une liste blanche de champs et ne fait que des GET en lecture", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/domains")) {
        return json({
          object: "list",
          has_more: false,
          data: [{ id: "d1", name: "Immojudis.com", status: "verified", api_token: "fuite" }],
        });
      }
      return json({
        id: "d1",
        name: "Immojudis.com",
        status: "verified",
        region: "eu-west-1",
        capabilities: { sending: "enabled", receiving: "disabled" },
        internal_secret: "fuite",
        records: [
          {
            record: "SPF",
            type: "TXT",
            name: "send",
            value: "v=spf1 secret",
            status: "verified",
            ttl: "Auto",
          },
          {
            record: "DKIM",
            type: "CNAME",
            name: "resend._domainkey",
            value: "dkim",
            status: "pending",
          },
        ],
      });
    });

    const result = await fetchResendDomains(KEY, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      ok: true,
      data: [
        {
          name: "immojudis.com",
          status: "verified",
          region: "eu-west-1",
          sending: true,
          receiving: false,
          records: [
            { kind: "SPF", type: "TXT", name: "send", status: "verified" },
            { kind: "DKIM", type: "CNAME", name: "resend._domainkey", status: "pending" },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("fuite");
    expect(JSON.stringify(result)).not.toContain("v=spf1");
    expect(
      fetchImpl.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).method]),
    ).toEqual([
      ["https://api.resend.com/domains", "GET"],
      ["https://api.resend.com/domains/d1", "GET"],
    ]);
  });

  it.each([
    [401, { name: "restricted_api_key", message: "clé re_secrète limitée" }, "missing_permission"],
    [403, { name: "forbidden" }, "missing_permission"],
    [401, { name: "invalid_api_key" }, "invalid_key"],
    [429, { name: "rate_limit_exceeded" }, "rate_limited"],
    [500, { name: "internal_server_error", message: "boom" }, "unavailable"],
  ] as const)("ramène la réponse %i %j à la catégorie %s", async (status, body, failure) => {
    const fetchImpl = vi.fn(async () => json(body, status));
    const result = await fetchResendDomains(KEY, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, failure });
    expect(JSON.stringify(result)).not.toContain("secrète");
  });

  it("ramène une panne réseau à « indisponible » sans message brut", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1 avec le jeton re_abc");
    });
    const result = await fetchResendDomains(KEY, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, failure: "unavailable" });
  });

  it("envoie la clé à Resend seulement, en en-tête", async () => {
    const fetchImpl = vi.fn(async () => json({ data: [] }));
    await fetchResendDomains(KEY, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/domains");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(init.body).toBeUndefined();
  });
});

describe("fetchResendWebhooks", () => {
  it("retire le secret de signature et réduit l'adresse à son origine et son chemin", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: [
          {
            id: "w1",
            endpoint:
              "https://user:pass@immojudis.com/api/webhooks/resend/account-emails?token=abc#x",
            status: "enabled",
            events: ["email.bounced", "email.complained", 3],
            signing_secret: "whsec_tres_secret",
          },
          { id: "w2", endpoint: "pas une url", status: "disabled", events: null },
        ],
      }),
    );

    const result = await fetchResendWebhooks(KEY, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      ok: true,
      data: [
        {
          endpoint: "https://immojudis.com/api/webhooks/resend/account-emails",
          enabled: true,
          events: ["email.bounced", "email.complained"],
        },
        { endpoint: "", enabled: false, events: null },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const leak of ["whsec_", "pass", "token=abc", "signing_secret"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("renvoie la catégorie d'erreur quand la clé n'a pas le droit de lire les webhooks", async () => {
    const fetchImpl = vi.fn(async () => json({ name: "restricted_api_key" }, 401));
    expect(await fetchResendWebhooks(KEY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      failure: "missing_permission",
    });
  });
});

describe("fetchResendEmail", () => {
  it("ne contacte pas Resend sans clé", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchResendEmail(null, "re_1", fetchImpl)).toEqual({
      ok: false,
      failure: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lit un email par un seul GET et ne recopie que le contenu et le dernier évènement", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json({
        id: "re_1",
        html: "<p>Salut</p>",
        text: "Salut",
        last_event: "delivered",
        bcc: ["x"],
      }),
    );
    const result = await fetchResendEmail(KEY, "re/1", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({
      ok: true,
      data: { html: "<p>Salut</p>", text: "Salut", lastEvent: "delivered" },
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.resend.com/emails/re%2F1");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
  });

  it("distingue un contenu expiré (404) des autres échecs", async () => {
    const expired = vi.fn(async () => json({ name: "not_found" }, 404));
    expect(await fetchResendEmail(KEY, "re_1", expired as unknown as typeof fetch)).toEqual({
      ok: false,
      failure: "expired",
    });
    for (const [status, failure] of [
      [401, "invalid_key"],
      [403, "missing_permission"],
      [429, "rate_limited"],
      [500, "unavailable"],
    ] as const) {
      const fetchImpl = vi.fn(async () => json({}, status));
      expect(await fetchResendEmail(KEY, "re_1", fetchImpl as unknown as typeof fetch)).toEqual({
        ok: false,
        failure,
      });
    }
  });
});
