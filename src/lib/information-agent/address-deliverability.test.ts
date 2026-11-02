import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ metadata: null as unknown }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.is = () => query;
      query.eq = () => query;
      query.maybeSingle = async () => ({ data: { metadata: registry.metadata }, error: null });
      return query;
    },
  },
}));

import {
  assertInformationAgentAddressDeliverable,
  countRecentTemporaryBounces,
  checkMailDomain,
  clearMailDomainCache,
  INFORMATION_AGENT_NO_MAIL_DOMAIN_MESSAGE,
  INFORMATION_AGENT_TEMPORARY_BOUNCES_MESSAGE,
  type MailDomainResolver,
} from "@/lib/information-agent/address-deliverability";

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function resolver(overrides: Partial<MailDomainResolver> = {}): MailDomainResolver & {
  resolveMx: ReturnType<typeof vi.fn>;
  resolveAddress: ReturnType<typeof vi.fn>;
} {
  return {
    resolveMx: vi.fn(async () => [{ exchange: "mx.cabinet.fr", priority: 10 }]),
    resolveAddress: vi.fn(async () => ["192.0.2.1"]),
    ...overrides,
  } as never;
}

describe("résolution MX / A d'un domaine", () => {
  beforeEach(() => clearMailDomainCache());

  it("accepte un domaine avec un MX", async () => {
    expect(await checkMailDomain("cabinet.fr", { resolver: resolver() })).toBe("ok");
  });

  it("bloque un domaine inexistant (NXDOMAIN)", async () => {
    const dns = resolver({ resolveMx: vi.fn(async () => Promise.reject(dnsError("ENOTFOUND"))) });
    expect(await checkMailDomain("inexistant.fr", { resolver: dns })).toBe("no_mail");
  });

  it("bloque un « null MX » (RFC 7505)", async () => {
    const dns = resolver({ resolveMx: vi.fn(async () => [{ exchange: "", priority: 0 }]) });
    expect(await checkMailDomain("nullmx.fr", { resolver: dns })).toBe("no_mail");
    expect(dns.resolveAddress).not.toHaveBeenCalled();
  });

  it("retombe sur l'adresse A/AAAA sans MX (MX implicite)", async () => {
    const dns = resolver({ resolveMx: vi.fn(async () => Promise.reject(dnsError("ENODATA"))) });
    expect(await checkMailDomain("implicite.fr", { resolver: dns })).toBe("ok");
    const none = resolver({
      resolveMx: vi.fn(async () => Promise.reject(dnsError("ENODATA"))),
      resolveAddress: vi.fn(async () => Promise.reject(dnsError("ENODATA"))),
    });
    expect(await checkMailDomain("rien.fr", { resolver: none })).toBe("no_mail");
  });

  it("ne bloque pas sur une panne DNS (SERVFAIL, délai) et ne la met pas en cache", async () => {
    const dns = resolver({ resolveMx: vi.fn(async () => Promise.reject(dnsError("ESERVFAIL"))) });
    expect(await checkMailDomain("panne.fr", { resolver: dns })).toBe("unknown");
    expect(await checkMailDomain("panne.fr", { resolver: dns })).toBe("unknown");
    expect(dns.resolveMx).toHaveBeenCalledTimes(2);
  });

  it("met le résultat en cache 24 h par domaine", async () => {
    const dns = resolver();
    const start = Date.parse("2026-11-02T10:00:00Z");
    await checkMailDomain("cabinet.fr", { resolver: dns, now: start });
    await checkMailDomain("CABINET.fr", { resolver: dns, now: start + 23 * 3_600_000 });
    expect(dns.resolveMx).toHaveBeenCalledTimes(1);
    await checkMailDomain("cabinet.fr", { resolver: dns, now: start + 25 * 3_600_000 });
    expect(dns.resolveMx).toHaveBeenCalledTimes(2);
  });
});

describe("contrôle de délivrabilité d'une adresse", () => {
  beforeEach(() => clearMailDomainCache());
  const on = { env: {} };

  it("laisse passer une adresse saine", async () => {
    await expect(
      assertInformationAgentAddressDeliverable("me@cabinet-dupont.fr", {
        ...on,
        resolver: resolver(),
        countTemporaryBounces: async () => 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuse une adresse mal formée avant tout appel DNS", async () => {
    const dns = resolver();
    await expect(
      assertInformationAgentAddressDeliverable("logo@2x.png", { ...on, resolver: dns }),
    ).rejects.toThrow(/extraction/);
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });

  it("refuse un domaine qui ne reçoit pas de courrier", async () => {
    const dns = resolver({ resolveMx: vi.fn(async () => Promise.reject(dnsError("ENOTFOUND"))) });
    await expect(
      assertInformationAgentAddressDeliverable("me@inexistant.fr", { ...on, resolver: dns }),
    ).rejects.toThrow(INFORMATION_AGENT_NO_MAIL_DOMAIN_MESSAGE);
  });

  it("accepte l'adresse si le DNS est en panne (non bloquant)", async () => {
    const dns = resolver({ resolveMx: vi.fn(async () => Promise.reject(dnsError("ETIMEOUT"))) });
    await expect(
      assertInformationAgentAddressDeliverable("me@cabinet.fr", {
        ...on,
        resolver: dns,
        countTemporaryBounces: async () => 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("bloque à deux rebonds passagers en 30 jours, pas à un", async () => {
    const base = { ...on, resolver: resolver() };
    await expect(
      assertInformationAgentAddressDeliverable("me@cabinet.fr", {
        ...base,
        countTemporaryBounces: async () => 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertInformationAgentAddressDeliverable("me@cabinet.fr", {
        ...base,
        countTemporaryBounces: async () => 2,
      }),
    ).rejects.toThrow(INFORMATION_AGENT_TEMPORARY_BOUNCES_MESSAGE);
  });

  it("ne bloque pas si le journal des envois est illisible", async () => {
    await expect(
      assertInformationAgentAddressDeliverable("me@cabinet.fr", {
        ...on,
        resolver: resolver(),
        countTemporaryBounces: async () => Promise.reject(new Error("base")),
      }),
    ).resolves.toBeUndefined();
  });

  it("est coupé par INFORMATION_AGENT_ADDRESS_CHECK=off", async () => {
    await expect(
      assertInformationAgentAddressDeliverable("logo@2x.png", {
        env: { INFORMATION_AGENT_ADDRESS_CHECK: "off" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("rebonds passagers lus dans le registre des contacts", () => {
  it("ne compte que les rebonds de moins de 30 jours", async () => {
    registry.metadata = {
      temporary_bounces: [
        "2026-09-01T10:00:00.000Z",
        "2026-10-20T10:00:00.000Z",
        "2026-11-01T10:00:00.000Z",
      ],
    };
    expect(
      await countRecentTemporaryBounces("me@cabinet.fr", new Date("2026-11-02T10:00:00Z")),
    ).toBe(2);
    registry.metadata = null;
    expect(
      await countRecentTemporaryBounces("me@cabinet.fr", new Date("2026-11-02T10:00:00Z")),
    ).toBe(0);
  });
});
