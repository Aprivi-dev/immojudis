import "server-only";
import { resolveMx, resolveTxt } from "node:dns/promises";

/**
 * Vérification publique des DNS (ce que voit le reste d'Internet, indépendamment de Resend) : DMARC,
 * SPF à la racine, MX du domaine de réception. Chaque requête a un délai de 3 s et toutes partent en
 * parallèle. Un enregistrement absent n'est pas une erreur de réseau : les deux cas sont distingués.
 */

const LOOKUP_TIMEOUT_MS = 3_000;

export type DnsResolver = {
  resolveTxt: (name: string) => Promise<string[][]>;
  resolveMx: (name: string) => Promise<Array<{ exchange: string; priority: number }>>;
};

export const systemDnsResolver: DnsResolver = { resolveTxt, resolveMx };

export type DnsLookup<T> =
  | { status: "present"; value: T }
  | { status: "absent" }
  | { status: "error" };

export type DomainDnsCheck = {
  domain: string;
  dmarc: DnsLookup<string> & { inheritedFrom?: string };
  spf: DnsLookup<string>;
  /** Seulement pour le domaine de réception de l'agent. */
  mx?: DnsLookup<string[]>;
};

/** DMARC minimal recommandé : surveiller sans rien bloquer (`p=none`), à durcir ensuite. */
export function recommendedDmarc(reportAddress: string | null): string {
  return `v=DMARC1; p=none${reportAddress ? `; rua=mailto:${reportAddress}` : ""}`;
}

function withTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns-timeout")), LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

const ABSENT_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function lookup<T>(
  task: () => Promise<T>,
  pick: (result: T) => unknown,
): Promise<DnsLookup<T>> {
  try {
    const result = await withTimeout(task());
    return pick(result) ? { status: "present", value: result } : { status: "absent" };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && ABSENT_CODES.has(code)
      ? { status: "absent" }
      : { status: "error" };
  }
}

const joined = (records: string[][]) => records.map((chunks) => chunks.join(""));

async function txtMatching(
  resolver: DnsResolver,
  name: string,
  prefix: string,
): Promise<DnsLookup<string>> {
  const found = await lookup(
    async () =>
      joined(await resolver.resolveTxt(name)).find((record) =>
        record.toLowerCase().startsWith(prefix),
      ) ?? "",
    (record) => record,
  );
  return found;
}

/** Domaine parent d'un sous-domaine (`reponses.immojudis.com` → `immojudis.com`), ou `null`. */
function parentDomain(domain: string): string | null {
  const labels = domain.split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : null;
}

async function dmarcOf(resolver: DnsResolver, domain: string): Promise<DomainDnsCheck["dmarc"]> {
  const own = await txtMatching(resolver, `_dmarc.${domain}`, "v=dmarc1");
  const parent = parentDomain(domain);
  if (own.status !== "absent" || !parent) return own;
  // Sans politique propre, celle du domaine parent s'applique (DMARC remonte d'un niveau).
  const inherited = await txtMatching(resolver, `_dmarc.${parent}`, "v=dmarc1");
  return inherited.status === "present" ? { ...inherited, inheritedFrom: parent } : inherited;
}

export async function checkDomainDns(
  domains: readonly string[],
  inboundDomain: string | null,
  resolver: DnsResolver = systemDnsResolver,
): Promise<DomainDnsCheck[]> {
  const unique = [...new Set([...domains, ...(inboundDomain ? [inboundDomain] : [])])];
  return Promise.all(
    unique.map(async (domain): Promise<DomainDnsCheck> => {
      const [dmarc, spf, mx] = await Promise.all([
        dmarcOf(resolver, domain),
        txtMatching(resolver, domain, "v=spf1"),
        domain === inboundDomain
          ? lookup(
              async () => (await resolver.resolveMx(domain)).map((record) => record.exchange),
              (hosts) => hosts.length > 0,
            )
          : Promise.resolve(undefined),
      ]);
      return { domain, dmarc, spf, ...(mx ? { mx } : {}) };
    }),
  );
}
