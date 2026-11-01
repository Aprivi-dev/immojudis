import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDomainDns, recommendedDmarc, type DnsResolver } from "./dns";

const notFound = () => Object.assign(new Error("queryTxt ENODATA"), { code: "ENODATA" });

function resolver(records: {
  txt?: Record<string, string[][] | "error" | "hang">;
  mx?: Record<string, Array<{ exchange: string; priority: number }> | "error">;
}): DnsResolver {
  return {
    resolveTxt: async (name) => {
      const value = records.txt?.[name];
      if (value === "hang") return new Promise<string[][]>(() => undefined);
      if (value === "error") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      if (!value) throw notFound();
      return value;
    },
    resolveMx: async (name) => {
      const value = records.mx?.[name];
      if (value === "error") throw Object.assign(new Error("servfail"), { code: "ESERVFAIL" });
      if (!value) throw notFound();
      return value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("recommendedDmarc", () => {
  it("surveille sans rien bloquer, avec l'adresse de rapports seulement si elle est connue", () => {
    expect(recommendedDmarc(null)).toBe("v=DMARC1; p=none");
    expect(recommendedDmarc("contact@immojudis.com")).toBe(
      "v=DMARC1; p=none; rua=mailto:contact@immojudis.com",
    );
  });
});

describe("checkDomainDns", () => {
  it("lit DMARC (en morceaux), SPF à la racine et MX du domaine de réception", async () => {
    const result = await checkDomainDns(
      ["immojudis.com"],
      "reponses.immojudis.com",
      resolver({
        txt: {
          "_dmarc.immojudis.com": [["v=DMARC1; p=none; ", "rua=mailto:contact@immojudis.com"]],
          "immojudis.com": [
            ["google-site-verification=x"],
            ["v=spf1 include:_spf.google.com ~all"],
          ],
        },
        mx: {
          "reponses.immojudis.com": [
            { exchange: "inbound-smtp.eu-west-1.amazonaws.com", priority: 10 },
          ],
        },
      }),
    );

    const root = result.find((check) => check.domain === "immojudis.com")!;
    expect(root.dmarc).toEqual({
      status: "present",
      value: "v=DMARC1; p=none; rua=mailto:contact@immojudis.com",
    });
    expect(root.spf).toEqual({
      status: "present",
      value: "v=spf1 include:_spf.google.com ~all",
    });
    expect(root.mx).toBeUndefined();
    const inbound = result.find((check) => check.domain === "reponses.immojudis.com")!;
    expect(inbound.mx).toEqual({
      status: "present",
      value: ["inbound-smtp.eu-west-1.amazonaws.com"],
    });
    // Sans politique propre, celle du domaine parent s'applique.
    expect(inbound.dmarc).toMatchObject({ status: "present", inheritedFrom: "immojudis.com" });
  });

  it("distingue un enregistrement absent d'une vérification impossible", async () => {
    const [absent] = await checkDomainDns(["exemple.fr"], null, resolver({}));
    expect(absent.dmarc).toEqual({ status: "absent" });
    expect(absent.spf).toEqual({ status: "absent" });

    const [failing] = await checkDomainDns(
      ["exemple.fr"],
      null,
      resolver({ txt: { "_dmarc.exemple.fr": "error", "exemple.fr": "error" } }),
    );
    expect(failing.dmarc).toEqual({ status: "error" });
    expect(failing.spf).toEqual({ status: "error" });
  });

  it("signale l'absence de MX du domaine de réception", async () => {
    const [check] = await checkDomainDns([], "reponses.exemple.fr", resolver({ mx: {} }));
    expect(check.mx).toEqual({ status: "absent" });
    const [broken] = await checkDomainDns(
      [],
      "reponses.exemple.fr",
      resolver({ mx: { "reponses.exemple.fr": "error" } }),
    );
    expect(broken.mx).toEqual({ status: "error" });
  });

  it("abandonne une requête sans réponse au bout de 3 s, toutes en parallèle", async () => {
    vi.useFakeTimers();
    const pending = checkDomainDns(
      ["a.fr", "b.fr"],
      null,
      resolver({
        txt: {
          "_dmarc.a.fr": "hang",
          "a.fr": "hang",
          "_dmarc.b.fr": "hang",
          "b.fr": "hang",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(3_001);
    const result = await pending;
    expect(result.map((check) => [check.domain, check.dmarc.status, check.spf.status])).toEqual([
      ["a.fr", "error", "error"],
      ["b.fr", "error", "error"],
    ]);
  });

  it("ne vérifie qu'une fois un domaine répété", async () => {
    const result = await checkDomainDns(["a.fr", "a.fr"], "a.fr", resolver({}));
    expect(result).toHaveLength(1);
    expect(result[0].mx).toEqual({ status: "absent" });
  });
});
