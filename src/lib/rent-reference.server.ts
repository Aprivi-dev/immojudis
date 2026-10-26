import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { serverEnv } from "@/lib/env";
import {
  isRentApplicable,
  rentReferenceFromAnilRow,
  rentSegmentFor,
  resolveRentReference,
  type RentLookup,
  type RentReference,
  type RentSegment,
} from "@/lib/rent-reference";
import { saleCommuneCode } from "@/lib/sale-commune-code";
import type { AuctionSale } from "@/lib/types";

// Lecture serveur de la carte des loyers de l'ANIL (`anil_rents`, table privée, rôle de service).
// Jamais importé par le navigateur : il reçoit la référence déjà résolue, en propriété. C'est, avec
// les types générés et les tests, le seul fichier qui nomme `anil_rents` (invariant de sécurité).

export type RentSaleFacts = Pick<AuctionSale, "id" | "department" | "property_type"> &
  Partial<Pick<AuctionSale, "rooms_count" | "postal_code">> & { raw_payload?: unknown };

const RENT_CODE_BATCH = 150;
const SALE_ID_BATCH = 100;
/** Lots lus en parallèle (`Promise.all`) : assez pour aller vite, pas assez pour saturer la base. */
const PARALLEL_BATCHES = 4;
/**
 * Plafond de ventes dont on relit le code commune en base par appel : une requête large ne doit pas
 * devenir une lecture de tout le catalogue. Au-delà, les ventes restantes gardent le repli
 * départemental (jamais une erreur).
 */
const MAX_COMMUNE_CODE_READS = 2_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20_000;

type Cached<T> = { value: T; expiresAt: number };
const communeCodeCache = new Map<string, Cached<string | null>>();
const anilReferenceCache = new Map<string, Cached<RentReference | null>>();

export function resetRentReferenceCachesForTests(): void {
  communeCodeCache.clear();
  anilReferenceCache.clear();
}

function fromCache<T>(cache: Map<string, Cached<T>>, key: string, now: number): Cached<T> | null {
  const cached = cache.get(key);
  return cached && cached.expiresAt > now ? cached : null;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T, now: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

function adminConfigured(): boolean {
  const { adminUrl, serviceRoleKey } = serverEnv().supabase;
  return Boolean(adminUrl && serviceRoleKey);
}

/** Exécute les lots par vagues de `PARALLEL_BATCHES` (`Promise.all`). */
async function inWaves<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += PARALLEL_BATCHES) {
    await Promise.all(items.slice(index, index + PARALLEL_BATCHES).map(run));
  }
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Code commune de chaque vente (clé : identifiant en minuscules). D'abord `saleCommuneCode` (la
 * seule fonction à rebrancher quand le code sera stocké sur la vente), puis, pour les ventes dont
 * la ligne n'a pas `raw_payload`, une lecture bornée de ses seuls champs de commune avec le rôle de
 * service (jamais l'objet `raw_payload` entier).
 */
async function resolveCommuneCodes(
  sales: readonly RentSaleFacts[],
): Promise<Map<string, string | null>> {
  const codes = new Map<string, string | null>();
  const toRead = new Map<string, RentSaleFacts>();
  const now = Date.now();
  for (const sale of sales) {
    const id = sale.id.toLowerCase();
    const known = saleCommuneCode(sale);
    if (known) {
      codes.set(id, known);
      continue;
    }
    const cached = fromCache(communeCodeCache, id, now);
    if (cached) {
      codes.set(id, cached.value);
    } else if (toRead.size < MAX_COMMUNE_CODE_READS) {
      toRead.set(id, sale);
    }
  }
  await inWaves(chunked([...toRead.keys()], SALE_ID_BATCH), async (ids) => {
    const { data, error } = await supabaseAdmin
      .from("auction_sales")
      .select(
        "id,postal_code,citycode:raw_payload->geocode->>citycode,accepted:raw_payload->geocode->>accepted,commune:raw_payload->commune",
      )
      .in("id", ids);
    if (error) throw error;
    const found = new Map<string, string | null>();
    for (const row of data ?? []) {
      found.set(
        row.id.toLowerCase(),
        saleCommuneCode({
          raw_payload: {
            geocode: { citycode: row.citycode, accepted: row.accepted },
            commune: row.commune,
          },
          postal_code: row.postal_code ?? toRead.get(row.id.toLowerCase())?.postal_code,
        }),
      );
    }
    for (const id of ids) {
      const code = found.get(id) ?? null;
      codes.set(id, code);
      remember(communeCodeCache, id, code, now);
    }
  });
  return codes;
}

/**
 * Segments à lire pour une vente : le sien, plus « tous appartements » pour un appartement T1-T2 ou
 * T3 et plus (repli dans la même commune avant le département). Jamais d'appartement pour une maison.
 */
function segmentsToRead(segment: RentSegment): RentSegment[] {
  return segment === "apt_1_2" || segment === "apt_3p" ? [segment, "apt_all"] : [segment];
}

async function readAnilReferences(
  wanted: ReadonlyMap<string, ReadonlySet<RentSegment>>,
): Promise<Map<string, RentReference | null>> {
  const references = new Map<string, RentReference | null>();
  const now = Date.now();
  const missing = new Map<string, Set<RentSegment>>();
  for (const [code, segments] of wanted) {
    for (const segment of segments) {
      const key = `${code}|${segment}`;
      const cached = fromCache(anilReferenceCache, key, now);
      if (cached) {
        references.set(key, cached.value);
      } else {
        const set = missing.get(code) ?? new Set<RentSegment>();
        set.add(segment);
        missing.set(code, set);
      }
    }
  }
  await inWaves(chunked([...missing.keys()], RENT_CODE_BATCH), async (codes) => {
    const segments = [...new Set(codes.flatMap((code) => [...(missing.get(code) ?? [])]))];
    const { data, error } = await supabaseAdmin
      .from("anil_rents")
      .select(
        "commune_code,segment,rent_per_m2,rent_low_per_m2,rent_high_per_m2,prediction_type,observations_commune,r2_adj,vintage,source_updated_on",
      )
      .in("commune_code", codes)
      .in("segment", segments);
    if (error) throw error;
    const read = new Map<string, RentReference | null>();
    for (const row of data ?? []) {
      read.set(`${row.commune_code}|${row.segment}`, rentReferenceFromAnilRow(row));
    }
    // Une ligne absente est mémorisée aussi (« pas de donnée ANIL pour cette commune et ce segment »).
    for (const code of codes) {
      for (const segment of missing.get(code) ?? []) {
        const key = `${code}|${segment}`;
        const value = read.get(key) ?? null;
        references.set(key, value);
        remember(anilReferenceCache, key, value, now);
      }
    }
  });
  return references;
}

export type RentBasis = "anil" | "mixed" | "department";

/**
 * De quoi sont faits les rendements d'un ensemble de ventes : `anil` (tous sur la carte de l'ANIL),
 * `department` (aucun, tous sur le repère départemental) ou `mixed`. Les biens sans loyer de référence
 * (non logements, département sans repère) n'entrent pas dans le compte.
 */
export function rentBasisOf(
  sales: readonly Pick<AuctionSale, "id" | "department" | "property_type">[],
  rents: RentLookup | undefined,
): RentBasis {
  let anil = 0;
  let department = 0;
  for (const sale of sales) {
    if (!isRentApplicable(sale)) continue;
    const reference = resolveRentReference(rents?.(sale), sale.department);
    if (!reference) continue;
    if (reference.source.startsWith("anil_")) anil += 1;
    else department += 1;
  }
  if (anil && department) return "mixed";
  return anil ? "anil" : "department";
}

export type RentLookupSession = {
  /**
   * Charge (ou réutilise) les références de ces ventes et rend la recherche, qui couvre aussi toutes
   * celles chargées plus tôt dans la session. Ne lève jamais : sans donnée, la recherche rend `null`
   * et l'appelant applique le repli départemental.
   */
  load(sales: readonly RentSaleFacts[]): Promise<RentLookup>;
};

/**
 * Une session partage ses références entre plusieurs lectures : le cron des alertes en ouvre une par
 * exécution, les exports et les statistiques une par requête. Un seul chargement par vente, même
 * demandé en même temps par plusieurs alertes.
 */
export function createRentLookupSession(): RentLookupSession {
  const references = new Map<string, RentReference | null>();
  const inflight = new Map<string, Promise<void>>();
  const lookup: RentLookup = (sale) => references.get(sale.id.toLowerCase()) ?? null;

  async function compute(sales: readonly RentSaleFacts[]): Promise<void> {
    const homes = sales.filter((sale) => isRentApplicable(sale));
    // Un bien qui n'est pas un logement (terrain, parking, local…) n'a aucune référence de loyer.
    for (const sale of sales) {
      if (!isRentApplicable(sale)) references.set(sale.id.toLowerCase(), null);
    }
    const communeCodes = await resolveCommuneCodes(homes);
    const wanted = new Map<string, Set<RentSegment>>();
    for (const sale of homes) {
      const code = communeCodes.get(sale.id.toLowerCase());
      if (!code) continue;
      const segments = wanted.get(code) ?? new Set<RentSegment>();
      for (const segment of segmentsToRead(rentSegmentFor(sale))) segments.add(segment);
      wanted.set(code, segments);
    }
    const anil = wanted.size ? await readAnilReferences(wanted) : new Map();
    for (const sale of homes) {
      const code = communeCodes.get(sale.id.toLowerCase());
      let fromAnil: RentReference | null = null;
      if (code) {
        for (const segment of segmentsToRead(rentSegmentFor(sale))) {
          fromAnil = anil.get(`${code}|${segment}`) ?? null;
          if (fromAnil) break;
        }
      }
      references.set(sale.id.toLowerCase(), resolveRentReference(fromAnil, sale.department));
    }
  }

  return {
    async load(sales) {
      if (!sales.length || !adminConfigured()) return lookup;
      const wanted = new Map<string, RentSaleFacts>();
      for (const sale of sales) {
        const id = sale.id.toLowerCase();
        if (!references.has(id) && !inflight.has(id)) wanted.set(id, sale);
      }
      if (wanted.size) {
        const batch = compute([...wanted.values()])
          .catch((error: unknown) => {
            console.error(
              "[rent-reference] ANIL rents unavailable, falling back to department rents",
              error,
            );
          })
          .finally(() => {
            for (const id of wanted.keys()) inflight.delete(id);
          });
        for (const id of wanted.keys()) inflight.set(id, batch);
      }
      await Promise.all(
        sales.map((sale) => inflight.get(sale.id.toLowerCase())).filter((promise) => promise),
      );
      return lookup;
    },
  };
}

/** Références de ces ventes, en une session. Ne lève jamais (voir `createRentLookupSession`). */
export function loadRentLookup(sales: readonly RentSaleFacts[]): Promise<RentLookup> {
  return createRentLookupSession().load(sales);
}

/**
 * Référence de loyer d'une vente (fiche, rapport). Elle reçoit la vente déjà lue (le segment dépend de
 * son type et de ses pièces : la fiche et le rapport doivent partir des mêmes) ; seul le code commune
 * est lu en base, une fois (mémorisé 6 heures, donc pas relu par le rapport qui suit la fiche).
 * Un identifiant seul relit aussi ces faits. `null` : non résolue (base indisponible ou vente
 * inconnue) ; l'appelant retombe sur le repli départemental.
 */
export async function loadSaleRentReference(
  sale: string | RentSaleFacts,
): Promise<RentReference | null> {
  if (!adminConfigured()) return null;
  try {
    let facts: RentSaleFacts;
    if (typeof sale === "string") {
      const { data, error } = await supabaseAdmin
        .from("auction_sales")
        .select("id,department,property_type,rooms_count,postal_code")
        .eq("id", sale)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      facts = data;
    } else {
      facts = sale;
    }
    return (await loadRentLookup([facts]))(facts);
  } catch (error) {
    console.error("[rent-reference] sale rent reference unavailable", error);
    return null;
  }
}
