import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { serverEnv } from "@/lib/env";
import { departmentCode } from "@/lib/department-code";
import { isMissingDatabaseObject } from "@/lib/postgrest-errors";
import {
  isRentApplicable,
  median,
  RENT_SEGMENTS,
  rentReferenceFromAnilMedian,
  rentReferenceFromAnilRow,
  rentSegmentFor,
  resolveRentReference,
  type RentLookup,
  type RentReference,
  type RentSegment,
} from "@/lib/rent-reference";
import { HOUSING_ZONINGS, type HousingTension, type HousingZoning } from "@/lib/housing-tension";
import {
  arrondissementCode,
  normalizeCommuneCode,
  parentCommuneCode,
  saleCommuneCode,
} from "@/lib/sale-commune-code";
import type { AuctionSale } from "@/lib/types";

// Lecture serveur de la carte des loyers de l'ANIL (`anil_rents`, table privée, rôle de service).
// Jamais importé par le navigateur : il reçoit la référence déjà résolue, en propriété. C'est, avec
// les types générés et les tests, le seul fichier qui nomme `anil_rents` (invariant de sécurité) ; il lit aussi
// le zonage « zone tendue » (`commune_housing_tension`, même règle).

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

/**
 * Arrondissements de Paris, Lyon et Marseille : une vente de la commune dont l'arrondissement n'est pas connu
 * (« 75000 Paris ») n'a pas de ligne ANIL (le fichier ne publie que les arrondissements) ; on prend alors la
 * médiane de leurs lignes.
 */
const PARENT_ARRONDISSEMENTS: Readonly<Record<string, readonly string[]>> = {
  "75056": Array.from({ length: 20 }, (_, index) => `751${String(index + 1).padStart(2, "0")}`),
  "13055": Array.from({ length: 16 }, (_, index) => `132${String(index + 1).padStart(2, "0")}`),
  "69123": Array.from({ length: 9 }, (_, index) => `6938${index + 1}`),
};

type Cached<T> = { value: T; expiresAt: number };
const communeCodeCache = new Map<string, Cached<string | null>>();
const anilReferenceCache = new Map<string, Cached<RentReference | null>>();
/** Médianes de repli (arrondissements d'une commune, département) : clé `parent|segment` ou `AAAA|segment`. */
const medianReferenceCache = new Map<string, Cached<RentReference | null>>();
/** Codes équivalents (fusions, changements de code) : clé = code, valeur = codes à essayer dans l'ordre. */
const codeAliasCache = new Map<string, Cached<string[]>>();
const housingTensionCache = new Map<string, Cached<HousingTension | null>>();

export function resetRentReferenceCachesForTests(): void {
  communeCodeCache.clear();
  anilReferenceCache.clear();
  medianReferenceCache.clear();
  codeAliasCache.clear();
  housingTensionCache.clear();
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

/** Codes déjà stockés dans `auction_sale_communes` ; vide si la table n'existe pas encore. */
async function readStoredSaleCommunes(
  ids: readonly string[],
): Promise<Map<string, { commune: string; arrondissement: string | null }>> {
  const stored = new Map<string, { commune: string; arrondissement: string | null }>();
  const { data, error } = await supabaseAdmin
    .from("auction_sale_communes")
    .select("sale_id,commune_insee,arrondissement_insee")
    .in("sale_id", [...ids]);
  if (error) {
    // Avant la migration 20261106100000 : on garde la lecture des champs bruts.
    if (isMissingDatabaseObject(error)) return stored;
    throw error;
  }
  for (const row of data ?? []) {
    const commune = normalizeCommuneCode(row.commune_insee);
    if (!commune) continue;
    stored.set(row.sale_id.toLowerCase(), {
      commune,
      arrondissement: normalizeCommuneCode(row.arrondissement_insee),
    });
  }
  return stored;
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
    const [{ data, error }, stored] = await Promise.all([
      supabaseAdmin
        .from("auction_sales")
        .select(
          "id,postal_code,citycode:raw_payload->geocode->>citycode,accepted:raw_payload->geocode->>accepted,commune:raw_payload->commune",
        )
        .in("id", ids),
      readStoredSaleCommunes(ids),
    ]);
    if (error) throw error;
    const found = new Map<string, string | null>();
    for (const row of data ?? []) {
      const id = row.id.toLowerCase();
      const postalCode = row.postal_code ?? toRead.get(id)?.postal_code;
      // La table des communes (remplie par le pipeline et le remplissage initial) passe avant les
      // champs bruts : elle couvre aussi les ventes résolues par code postal ou par nom.
      const storedCommune = stored.get(id);
      found.set(
        id,
        storedCommune
          ? (storedCommune.arrondissement ?? arrondissementCode(storedCommune.commune, postalCode))
          : saleCommuneCode({
              raw_payload: {
                geocode: { citycode: row.citycode, accepted: row.accepted },
                commune: row.commune,
              },
              postal_code: postalCode,
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

/**
 * Codes à essayer à la place de ceux-ci quand la commune n'a pas de ligne ANIL (`app_private.commune_code_history`) :
 * d'abord le code d'arrivée d'une fusion ou d'un changement de code, puis le code de départ. Vide avant la
 * migration 20261108120200 ou sans passage connu : la lecture reste celle d'avant.
 */
async function readCodeAliases(codes: readonly string[]): Promise<Map<string, string[]>> {
  const aliases = new Map<string, string[]>();
  const now = Date.now();
  const missing: string[] = [];
  for (const code of codes) {
    const cached = fromCache(codeAliasCache, code, now);
    if (cached) aliases.set(code, cached.value);
    else missing.push(code);
  }
  await inWaves(chunked(missing, 400), async (batch) => {
    const { data, error } = await supabaseAdmin.rpc("commune_code_aliases", { p_codes: batch });
    if (error) {
      if (isMissingDatabaseObject(error)) return;
      throw error;
    }
    const found = new Map<string, { newer: string[]; older: string[] }>();
    for (const row of [...(data ?? [])].sort((a, b) => a.depth - b.depth)) {
      const entry = found.get(row.code) ?? { newer: [], older: [] };
      (row.direction === "new" ? entry.newer : entry.older).push(row.alias);
      found.set(row.code, entry);
    }
    for (const code of batch) {
      const entry = found.get(code);
      const ordered = entry ? [...new Set([...entry.newer, ...entry.older])] : [];
      aliases.set(code, ordered);
      remember(codeAliasCache, code, ordered, now);
    }
  });
  return aliases;
}

/** Médiane des arrondissements de ces communes (Paris, Lyon, Marseille), par segment. */
async function readArrondissementMedians(
  wanted: ReadonlyMap<string, ReadonlySet<RentSegment>>,
): Promise<Map<string, RentReference | null>> {
  const references = new Map<string, RentReference | null>();
  const now = Date.now();
  const missing = new Map<string, Set<RentSegment>>();
  for (const [parent, segments] of wanted) {
    for (const segment of segments) {
      const key = `${parent}|${segment}`;
      const cached = fromCache(medianReferenceCache, key, now);
      if (cached) {
        references.set(key, cached.value);
      } else {
        const set = missing.get(parent) ?? new Set<RentSegment>();
        set.add(segment);
        missing.set(parent, set);
      }
    }
  }
  await inWaves([...missing.keys()], async (parent) => {
    const segments = [...(missing.get(parent) ?? [])];
    const { data, error } = await supabaseAdmin
      .from("anil_rents")
      .select("commune_code,segment,rent_per_m2,vintage,source_updated_on")
      .in("commune_code", [...(PARENT_ARRONDISSEMENTS[parent] ?? [])])
      .in("segment", segments);
    if (error) throw error;
    for (const segment of segments) {
      const rows = (data ?? []).filter((row) => row.segment === segment);
      const value = rentReferenceFromAnilMedian({
        rentPerM2: median(rows.map((row) => Number(row.rent_per_m2))) ?? Number.NaN,
        source: "anil_arrondissements_median",
        segment,
        communeCode: parent,
        vintage: rows.length ? Math.max(...rows.map((row) => Number(row.vintage))) : null,
        sourceUpdatedOn:
          rows
            .map((row) => row.source_updated_on)
            .filter((day): day is string => typeof day === "string")
            .sort()
            .at(-1) ?? null,
      });
      references.set(`${parent}|${segment}`, value);
      remember(medianReferenceCache, `${parent}|${segment}`, value, now);
    }
  });
  return references;
}

/** Médiane des communes du département, par segment (`anil_department_medians`), clé `AAAA|segment`. */
async function readDepartmentMedians(
  departments: readonly string[],
): Promise<Map<string, RentReference | null>> {
  const references = new Map<string, RentReference | null>();
  const now = Date.now();
  const missing: string[] = [];
  for (const department of departments) {
    const cached = RENT_SEGMENTS.map((segment) =>
      fromCache(medianReferenceCache, `${department}|${segment}`, now),
    );
    if (cached.every((entry) => entry)) {
      RENT_SEGMENTS.forEach((segment, index) =>
        references.set(`${department}|${segment}`, cached[index]?.value ?? null),
      );
    } else {
      missing.push(department);
    }
  }
  await inWaves(chunked(missing, 100), async (batch) => {
    const { data, error } = await supabaseAdmin.rpc("anil_department_medians", {
      p_departments: batch,
    });
    if (error) {
      if (isMissingDatabaseObject(error)) return;
      throw error;
    }
    const read = new Map<string, RentReference | null>();
    for (const row of data ?? []) {
      const segment = RENT_SEGMENTS.find((item) => item === row.segment) ?? null;
      read.set(
        `${row.department_code}|${row.segment}`,
        rentReferenceFromAnilMedian({
          rentPerM2: Number(row.rent_per_m2),
          source: "anil_department_median",
          segment,
          vintage: row.vintage == null ? null : Number(row.vintage),
          sourceUpdatedOn: row.source_updated_on,
        }),
      );
    }
    for (const department of batch) {
      for (const segment of RENT_SEGMENTS) {
        const key = `${department}|${segment}`;
        const value = read.get(key) ?? null;
        references.set(key, value);
        remember(medianReferenceCache, key, value, now);
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
  /**
   * « ANIL indisponible » : vrai quand la lecture de la carte des loyers a échoué (ou n'a pas pu être tentée, base de
   * service non configurée) pour au moins un de ces logements, qui est alors resté sur le repère départemental. Un
   * bien qui n'est pas un logement n'a pas de référence et n'est jamais « indisponible ». Une panne ne se mémorise
   * pas : la lecture suivante est retentée.
   */
  unavailable(sales: readonly RentSaleFacts[]): boolean;
};

/** Un repli facultatif qui échoue ne fait pas perdre les références déjà trouvées : on passe au suivant. */
async function optional<T>(label: string, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(`[rent-reference] ${label} unavailable, trying the next fallback`, error);
    return empty;
  }
}

function parentOf(code: string): string | null {
  if (PARENT_ARRONDISSEMENTS[code]) return code;
  for (const [parent, arrondissements] of Object.entries(PARENT_ARRONDISSEMENTS)) {
    if (arrondissements.includes(code)) return parent;
  }
  return null;
}

/**
 * Références des ventes dont la commune n'a pas de ligne ANIL, dans l'ordre : (1) l'autre code de la commune
 * après une fusion ou un changement de code (`indicative`), (2) la médiane des arrondissements pour Paris, Lyon
 * et Marseille, (3) la médiane du département calculée sur la carte. Au-delà, l'appelant garde la table
 * départementale codée en dur, puis « Loyer de référence indisponible » (Mayotte, absente de la carte).
 */
async function readFallbackReferences(
  sales: readonly RentSaleFacts[],
  communeCodes: ReadonlyMap<string, string | null>,
): Promise<Map<string, RentReference>> {
  const found = new Map<string, RentReference>();
  const pending = () => sales.filter((sale) => !found.has(sale.id.toLowerCase()));
  const cascade = (sale: RentSaleFacts) => segmentsToRead(rentSegmentFor(sale));

  // 1. Autre code de la commune (fusion, changement de code).
  const codes = [
    ...new Set(
      pending()
        .map((sale) => communeCodes.get(sale.id.toLowerCase()))
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  if (codes.length) {
    const aliases = await optional(
      "commune code history",
      () => readCodeAliases(codes),
      new Map<string, string[]>(),
    );
    const wanted = new Map<string, Set<RentSegment>>();
    for (const sale of pending()) {
      const code = communeCodes.get(sale.id.toLowerCase());
      for (const alias of (code && aliases.get(code)) || []) {
        const segments = wanted.get(alias) ?? new Set<RentSegment>();
        for (const segment of cascade(sale)) segments.add(segment);
        wanted.set(alias, segments);
      }
    }
    const aliasReferences = wanted.size
      ? await optional(
          "aliased commune rents",
          () => readAnilReferences(wanted),
          new Map<string, RentReference | null>(),
        )
      : new Map<string, RentReference | null>();
    for (const sale of pending()) {
      const code = communeCodes.get(sale.id.toLowerCase());
      const match = ((code && aliases.get(code)) || [])
        .flatMap((alias) =>
          cascade(sale).map((segment) => aliasReferences.get(`${alias}|${segment}`)),
        )
        .find((reference) => reference);
      // Ce n'est pas la commune de la vente telle que la carte la décrit : au mieux une indication.
      if (match) found.set(sale.id.toLowerCase(), { ...match, reliability: "indicative" });
    }
  }

  // 2. Paris, Lyon ou Marseille sans ligne pour leur arrondissement : la médiane de leurs arrondissements.
  const parents = new Map<string, Set<RentSegment>>();
  for (const sale of pending()) {
    const parent = parentOf(communeCodes.get(sale.id.toLowerCase()) ?? "");
    if (!parent) continue;
    const segments = parents.get(parent) ?? new Set<RentSegment>();
    for (const segment of cascade(sale)) segments.add(segment);
    parents.set(parent, segments);
  }
  if (parents.size) {
    const medians = await optional(
      "arrondissement medians",
      () => readArrondissementMedians(parents),
      new Map<string, RentReference | null>(),
    );
    for (const sale of pending()) {
      const parent = parentOf(communeCodes.get(sale.id.toLowerCase()) ?? "");
      const match = parent
        ? cascade(sale)
            .map((segment) => medians.get(`${parent}|${segment}`))
            .find((reference) => reference)
        : null;
      if (match) found.set(sale.id.toLowerCase(), match);
    }
  }

  // 3. Médiane du département sur la carte (avant la table codée en dur).
  const departments = [
    ...new Set(
      pending()
        .map((sale) => departmentCode(sale.department))
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  if (departments.length) {
    const medians = await optional(
      "department medians",
      () => readDepartmentMedians(departments),
      new Map<string, RentReference | null>(),
    );
    for (const sale of pending()) {
      const department = departmentCode(sale.department);
      const match = department
        ? cascade(sale)
            .map((segment) => medians.get(`${department}|${segment}`))
            .find((reference) => reference)
        : null;
      if (match) found.set(sale.id.toLowerCase(), match);
    }
  }
  return found;
}

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
    const fromCommune = new Map<string, RentReference>();
    for (const sale of homes) {
      const code = communeCodes.get(sale.id.toLowerCase());
      if (!code) continue;
      for (const segment of segmentsToRead(rentSegmentFor(sale))) {
        const reference = anil.get(`${code}|${segment}`);
        if (reference) {
          fromCommune.set(sale.id.toLowerCase(), reference);
          break;
        }
      }
    }
    const unresolved = homes.filter((sale) => !fromCommune.has(sale.id.toLowerCase()));
    const fallbacks = unresolved.length
      ? await readFallbackReferences(unresolved, communeCodes)
      : new Map<string, RentReference>();
    for (const sale of homes) {
      const id = sale.id.toLowerCase();
      references.set(
        id,
        resolveRentReference(fromCommune.get(id) ?? fallbacks.get(id) ?? null, sale.department),
      );
    }
  }

  return {
    unavailable(sales) {
      return sales.some((sale) => isRentApplicable(sale) && !references.has(sale.id.toLowerCase()));
    },
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

/**
 * Zonage « zone tendue » (TLV) de la commune d'une vente, pour la fiche. Le code vient de la même résolution que le
 * loyer (`auction_sale_communes`, puis les champs bruts), ramené à la commune parent : un arrondissement de Paris, Lyon
 * ou Marseille se lit sur 75056, 69123 ou 13055, les seules lignes de la table. `null` : commune inconnue, absente du
 * fichier ou base indisponible (la fiche n'affiche alors rien). Mémorisé 6 heures, comme le reste.
 */
export async function loadSaleHousingTension(
  sale: string | RentSaleFacts,
): Promise<HousingTension | null> {
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
    const codes = await resolveCommuneCodes([facts]);
    const parent = parentCommuneCode(codes.get(facts.id.toLowerCase()));
    if (!parent) return null;
    const now = Date.now();
    const cached = fromCache(housingTensionCache, parent, now);
    if (cached) return cached.value;
    const { data, error } = await supabaseAdmin
      .from("commune_housing_tension")
      .select("commune_code,zoning_post_decree,decree_reference,source_updated_on,source_url")
      .eq("commune_code", parent)
      .maybeSingle();
    if (error) {
      // Avant la migration 20261107100100 : pas de zonage, sans bruit.
      if (error.code === "42P01" || error.code === "PGRST205") return null;
      throw error;
    }
    const zoning = HOUSING_ZONINGS.find(
      (item): item is HousingZoning => item === data?.zoning_post_decree,
    );
    const value: HousingTension | null =
      data && zoning
        ? {
            communeCode: data.commune_code,
            zoning,
            decreeReference: data.decree_reference || null,
            sourceUpdatedOn: data.source_updated_on,
            sourceUrl: data.source_url || null,
          }
        : null;
    remember(housingTensionCache, parent, value, now);
    return value;
  } catch (error) {
    console.error("[rent-reference] housing tension unavailable", error);
    return null;
  }
}
