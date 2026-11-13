import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DnsResolver } from "./dns";
import { ACCOUNT_EMAIL_WEBHOOK_EVENTS } from "@/lib/account-email-delivery-events";
import { INFORMATION_AGENT_WEBHOOK_EVENTS } from "@/lib/information-agent-inbound";
import { getEmailAddressesReport, resetEmailAddressesCache } from "./addresses";

// Valeurs reconnaissables : si l'une d'elles apparaît dans le rapport, le test échoue.
const SECRETS = {
  RESEND_API_KEY: "re_SENTINELLE_AAAAAAA",
  RESEND_WEBHOOK_SECRET: "whsec_SENTINELLE_AAAAAAA",
  RESEND_ACCOUNT_WEBHOOK_SECRET: "whsec_SENTINELLE_BBBBBBB",
  INFORMATION_AGENT_PORTAL_SECRET: "SENTINELLE_PORTAIL_SECRET_DE_32_OCTETS",
} as const;

const ADDRESSES = {
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.com>",
  TRANSACTIONAL_EMAIL_FROM: "Immojudis <compte@immojudis.com>",
  INFORMATION_AGENT_EMAIL_FROM: "Assistant Immojudis <assistant@immojudis.com>",
  CONTACT_EMAIL_FROM: "Immojudis <contact@immojudis.com>",
  EMAIL_REPLY_TO: "contact@immojudis.com",
  NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.com",
  INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.com",
} as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type ResendFixture = {
  domains?: Array<{ name: string; status?: string }>;
  webhooks?: Array<{ endpoint: string; status?: string; events: string[] | null }>;
  domainsStatus?: number;
};

function resendFetch(fixture: ResendFixture) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/domains") {
      if (fixture.domainsStatus) return json({ name: "restricted_api_key" }, fixture.domainsStatus);
      return json({
        data: (fixture.domains ?? []).map((domain, index) => ({ id: `d${index}`, ...domain })),
      });
    }
    if (path.startsWith("/domains/")) {
      const index = Number(path.slice("/domains/d".length));
      const domain = fixture.domains?.[index];
      return json({
        ...domain,
        status: domain?.status ?? "verified",
        capabilities: { sending: "enabled", receiving: "enabled" },
        records: [{ record: "DKIM", type: "CNAME", name: "k", status: "verified", value: "x" }],
      });
    }
    if (path === "/webhooks") {
      return json({
        data: (fixture.webhooks ?? []).map((hook) => ({
          status: "enabled",
          signing_secret: "whsec_FUITE_FUITE",
          ...hook,
        })),
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const healthyDns: DnsResolver = {
  resolveTxt: async (name) => {
    if (name.startsWith("_dmarc.")) return [["v=DMARC1; p=none"]];
    return [["v=spf1 include:amazonses.com ~all"]];
  },
  resolveMx: async () => [{ exchange: "inbound-smtp.eu-west-1.amazonaws.com", priority: 10 }],
};

const HEALTHY: ResendFixture = {
  domains: [{ name: "immojudis.com" }],
  webhooks: [
    {
      endpoint: "https://immojudis.com/api/webhooks/resend/account-emails",
      events: [
        "email.bounced",
        "email.complained",
        "email.delivered",
        "email.delivery_delayed",
        "email.failed",
      ],
    },
    {
      endpoint: "https://immojudis.com/api/webhooks/resend/information-agent",
      events: ["email.received", "email.bounced", "email.complained"],
    },
  ],
};

function configure(overrides: Record<string, string | undefined> = {}) {
  for (const [name, value] of Object.entries({ ...ADDRESSES, ...SECRETS, ...overrides })) {
    if (value === undefined) vi.stubEnv(name, "");
    else vi.stubEnv(name, value);
  }
}

beforeEach(() => {
  resetEmailAddressesCache();
  vi.useRealTimers();
});
afterEach(() => vi.unstubAllEnvs());

describe("rapport de l'onglet Adresses", () => {
  it("ne renvoie jamais un secret : ni valeur, ni préfixe, ni longueur", async () => {
    configure();
    const fetchImpl = resendFetch(HEALTHY);

    const report = await getEmailAddressesReport({ fetchImpl, resolver: healthyDns });

    const serialized = JSON.stringify(report);
    for (const value of Object.values(SECRETS)) {
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(value.slice(0, 8));
    }
    expect(serialized).not.toContain("whsec_FUITE");
    expect(report.secrets).toEqual([
      expect.objectContaining({ name: "RESEND_API_KEY", configured: true }),
      expect.objectContaining({ name: "RESEND_WEBHOOK_SECRET", configured: true }),
      expect.objectContaining({ name: "RESEND_ACCOUNT_WEBHOOK_SECRET", configured: true }),
      expect.objectContaining({ name: "INFORMATION_AGENT_PORTAL_SECRET", configured: true }),
    ]);
    for (const secret of report.secrets)
      expect(Object.keys(secret).sort()).toEqual(["configured", "name", "purpose"]);
  });

  it("n'accepte que les variables de la liste blanche, sans lire le reste de l'environnement", async () => {
    configure();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "SENTINELLE_SSSSSS");
    vi.stubEnv("STRIPE_SECRET_KEY", "SENTINELLE_PPPPPP");
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch(HEALTHY),
      resolver: healthyDns,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("SENTINELLE");
    expect(report.addresses.map((row) => row.variable)).toEqual([
      "NOREPLY_EMAIL_FROM",
      "ALERT_EMAIL_FROM",
      "TRANSACTIONAL_EMAIL_FROM",
      "INFORMATION_AGENT_EMAIL_FROM",
      "CONTACT_EMAIL_FROM",
      "EMAIL_REPLY_TO",
      "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL",
      "CONTACT_EMAIL_TO",
      "OPERATIONS_ALERT_EMAIL_TO",
      "INFORMATION_AGENT_INBOUND_DOMAIN",
    ]);
  });

  it("n'a aucune alerte quand tout est en ordre", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch(HEALTHY),
      resolver: healthyDns,
    });
    expect(report.alerts).toEqual([]);
    expect(report.resend).toMatchObject({ ok: true });
    expect(report.webhooks).toMatchObject({
      ok: true,
      items: [expect.objectContaining({ state: "ok" }), expect.objectContaining({ state: "ok" })],
    });
  });

  it("alerte quand le domaine d'un expéditeur est absent de Resend", async () => {
    configure({ CONTACT_EMAIL_FROM: "Immojudis <contact@autre-domaine.fr>" });
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch(HEALTHY),
      resolver: healthyDns,
    });
    expect(report.alerts.map((alert) => alert.message)).toEqual([
      expect.stringContaining(
        "autre-domaine.fr (CONTACT_EMAIL_FROM) n’est pas déclaré chez Resend",
      ),
    ]);
  });

  it("alerte quand un domaine n'est pas vérifié", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch({
        ...HEALTHY,
        domains: [{ name: "immojudis.com", status: "pending" }],
      }),
      resolver: healthyDns,
    });
    expect(report.alerts[0].message).toContain("n’est pas vérifié");
  });

  it("alerte quand un évènement attendu manque, ou quand un webhook est absent", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch({
        ...HEALTHY,
        webhooks: [
          {
            endpoint: "https://immojudis.com/api/webhooks/resend/account-emails",
            events: ["email.bounced"],
          },
        ],
      }),
      resolver: healthyDns,
    });
    const messages = report.alerts.map((alert) => alert.message);
    expect(messages).toEqual([
      expect.stringContaining(
        "évènement(s) manquant(s) : email.delivered, email.delivery_delayed, email.failed, email.complained",
      ),
      expect.stringContaining("aucun webhook ne pointe vers cette route"),
    ]);
  });

  it("attend du webhook de l'agent les rebonds et plaintes qu'il traite, pas seulement les réponses", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch({
        ...HEALTHY,
        webhooks: [
          HEALTHY.webhooks![0],
          {
            endpoint: "https://immojudis.com/api/webhooks/resend/information-agent",
            events: ["email.received"],
          },
        ],
      }),
      resolver: healthyDns,
    });
    expect(report.webhooks).toMatchObject({
      ok: true,
      items: [
        { state: "ok" },
        { state: "events_missing", missingEvents: ["email.bounced", "email.complained"] },
      ],
    });
  });

  it("attend exactement les évènements que chaque module de traitement déclare", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch({ ...HEALTHY, webhooks: [] }),
      resolver: healthyDns,
    });
    expect(report.webhooks).toMatchObject({
      ok: true,
      items: [
        {
          path: "/api/webhooks/resend/account-emails",
          missingEvents: [...ACCOUNT_EMAIL_WEBHOOK_EVENTS],
        },
        {
          path: "/api/webhooks/resend/information-agent",
          missingEvents: [...INFORMATION_AGENT_WEBHOOK_EVENTS],
        },
      ],
    });
    expect(INFORMATION_AGENT_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining(["email.received", "email.bounced", "email.complained"]),
    );
  });

  it("alerte quand le domaine de réception n'a pas de MX", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch(HEALTHY),
      resolver: {
        ...healthyDns,
        resolveMx: async () => {
          throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
        },
      },
    });
    expect(report.alerts.map((alert) => alert.message)).toEqual([
      expect.stringContaining("reponses.immojudis.com n’a aucun enregistrement MX"),
    ]);
  });

  it("met un DMARC absent en alerte avec la valeur recommandée", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch(HEALTHY),
      resolver: {
        ...healthyDns,
        resolveTxt: async (name) => {
          if (name.startsWith("_dmarc.")) {
            throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
          }
          return [["v=spf1 ~all"]];
        },
      },
    });
    expect(report.dmarcRecommended).toBe("v=DMARC1; p=none; rua=mailto:contact@immojudis.com");
    expect(report.alerts.map((alert) => alert.message)).toEqual([
      expect.stringContaining(
        "Aucun DMARC publié pour immojudis.com. Valeur recommandée pour _dmarc.immojudis.com : v=DMARC1; p=none; rua=mailto:contact@immojudis.com",
      ),
    ]);
  });

  it("ramène une erreur Resend à une catégorie et garde le reste du rapport", async () => {
    configure();
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch({ domainsStatus: 401 }),
      resolver: healthyDns,
    });
    expect(report.resend).toEqual({ ok: false, failure: "missing_permission" });
    expect(report.addresses.length).toBeGreaterThan(0);
    expect(report.dns.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("restricted_api_key");
  });

  it("n'appelle pas Resend sans RESEND_API_KEY", async () => {
    configure({ RESEND_API_KEY: undefined });
    const fetchImpl = resendFetch(HEALTHY);
    const report = await getEmailAddressesReport({ fetchImpl, resolver: healthyDns });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.resend).toEqual({ ok: false, failure: "not_configured" });
    expect(report.secrets[0]).toMatchObject({ name: "RESEND_API_KEY", configured: false });
  });

  it("ne dit pas configuré un secret des liens de l'agent trop court pour signer", async () => {
    configure({ INFORMATION_AGENT_PORTAL_SECRET: "court-mais-non-vide" });
    const report = await getEmailAddressesReport({
      fetchImpl: resendFetch(HEALTHY),
      resolver: healthyDns,
    });
    expect(report.secrets[3]).toMatchObject({
      name: "INFORMATION_AGENT_PORTAL_SECRET",
      configured: false,
    });
  });

  it("ne fait que des lectures chez Resend (GET), jamais un envoi", async () => {
    configure();
    const fetchImpl = resendFetch(HEALTHY);
    await getEmailAddressesReport({ fetchImpl, resolver: healthyDns });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit]
    >;
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, init] of calls) {
      expect(init.method).toBe("GET");
      expect(String(url)).not.toContain("/emails");
    }
  });
});

describe("cache du rapport", () => {
  it("garde le rapport 60 s, et « Revérifier » le recalcule au plus toutes les 5 s", async () => {
    configure();
    const fetchImpl = resendFetch(HEALTHY);
    const start = new Date("2026-11-02T10:00:00Z");
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    const run = (seconds: number, refresh = false) =>
      getEmailAddressesReport({ fetchImpl, resolver: healthyDns, now: at(seconds), refresh });
    const callCount = () => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    const first = await run(0);
    const afterFirst = callCount();
    expect(await run(30)).toBe(first);
    expect(callCount()).toBe(afterFirst);

    // Revérifier trop tôt : le rapport récent est renvoyé.
    expect(await run(3, true)).toBe(first);
    expect(callCount()).toBe(afterFirst);

    // Revérifier plus de 5 s après : nouvelle lecture.
    const refreshed = await run(10, true);
    expect(refreshed).not.toBe(first);
    expect(callCount()).toBeGreaterThan(afterFirst);

    // Au-delà de 60 s sans demande, la lecture normale se refait aussi.
    const afterRefresh = callCount();
    await run(10 + 61);
    expect(callCount()).toBeGreaterThan(afterRefresh);
  });
});
