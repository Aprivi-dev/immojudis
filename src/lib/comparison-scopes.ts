import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { propertyFamily } from "@/lib/property-type-family";

/**
 * Périmètres des ventes de comparaison d'une vente (analyse de marché, ventes passées, ventes
 * actives du rapport) : du plus étroit au plus large, chacun nommé par les critères qu'il pose.
 */
export type ComparisonScope = {
  label: string;
  city?: string;
  department?: string;
  tribunalCode?: string;
  propertyType?: string;
};

/** Ce qu'on sait de la vente de référence (ou du périmètre demandé). */
type ComparisonBase = {
  city?: string | null;
  department?: string | null;
  tribunalCode?: string | null;
  propertyType?: string | null;
};

function scope(criteria: Omit<ComparisonScope, "label">): ComparisonScope {
  const place = criteria.city
    ? "Même ville"
    : criteria.tribunalCode
      ? "Même tribunal"
      : criteria.department
        ? "Même département"
        : null;
  const label = place
    ? `${place}${criteria.propertyType ? " et même type de bien" : ""}`
    : "Même type de bien";
  return { label, ...criteria };
}

/**
 * La cascade : ville, tribunal, puis département, avec le type de bien ; puis département et ville
 * sans le type. La ville est prise avec son département quand il est connu : des communes de
 * départements différents portent le même nom. Le type seul, partout en France, ferme la cascade
 * avec `nationwide` ; sans lieu connu, c'est le seul périmètre.
 *
 * Un type inconnu ou « autre » n'est pas un critère (`matchesPropertyFamily`) : « unknown » ne dit
 * rien du bien, et deux biens « other » ne se ressemblent pas pour autant.
 */
export function comparisonScopes(
  base: ComparisonBase,
  options: { nationwide?: boolean } = {},
): ComparisonScope[] {
  const city = base.city || undefined;
  const department = base.department || undefined;
  const tribunalCode = base.tribunalCode || undefined;
  const family = propertyFamily(base.propertyType);
  const propertyType =
    family === "unknown" || family === "other" ? undefined : base.propertyType || undefined;
  const scopes: ComparisonScope[] = [];

  if (city) scopes.push(scope({ city, department, propertyType }));
  if (tribunalCode) scopes.push(scope({ tribunalCode, propertyType }));
  if (department) {
    scopes.push(scope({ department, propertyType }));
    scopes.push(scope({ department }));
  }
  if (city) scopes.push(scope({ city, department }));
  if (propertyType && (options.nationwide || scopes.length === 0)) {
    scopes.push(scope({ propertyType }));
  }

  const seen = new Set<string>();
  return scopes.filter((item) => {
    const key = [item.city, item.department, item.tribunalCode, item.propertyType].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type ScopeFilterableQuery = {
  eq: (column: string, value: string) => ScopeFilterableQuery;
  neq: (column: string, value: string) => ScopeFilterableQuery;
};

/**
 * Les filtres d'un périmètre sur une requête des ventes, sans la vente de référence : elle ne se
 * compare pas à elle-même, ni ne compte dans l'échantillon qui la situe.
 */
export function filterComparisonScope<TQuery>(
  query: TQuery,
  scope: ComparisonScope,
  referenceSaleId: string | null | undefined,
): TQuery {
  let q = query as ScopeFilterableQuery;
  if (referenceSaleId) q = q.neq("id", referenceSaleId);
  if (scope.city) q = q.eq("city", scope.city);
  if (scope.department) q = q.eq("department", scope.department);
  if (scope.tribunalCode) q = q.eq("tribunal_code", scope.tribunalCode);
  if (scope.propertyType) q = q.eq("property_type", scope.propertyType);
  return q as TQuery;
}

/**
 * Les ventes datées du premier périmètre de la cascade qui en compte au moins `minRows` (sinon du
 * dernier), des plus récentes aux plus anciennes entre `fromDate` et `toDate`, sans la vente de
 * référence : la lecture de l'analyse de marché et des ventes passées.
 *
 * Sans aucun périmètre, la demande est refusée (400), comme une demande qui ne nomme aucun lieu :
 * les schémas de ces deux routes exigent un lieu quand elles n'ont pas de vente de référence, donc
 * seule une vente de référence sans rien de comparable y mène.
 */
export async function readComparisonSales<Row>({
  auth,
  base,
  columns,
  fromDate,
  toDate,
  limit,
  referenceSaleId,
  minRows,
}: {
  auth: SupabaseAuthContext;
  base: ComparisonBase;
  columns: string;
  fromDate: string;
  toDate: string;
  limit: number;
  referenceSaleId: string | null;
  minRows: number;
}): Promise<{ scope: ComparisonScope; rows: Row[] }> {
  const read = async (scope: ComparisonScope): Promise<Row[]> => {
    const query = auth.supabase
      .from("v_auction_sales_app")
      .select(columns)
      .not("id", "is", null)
      .not("sale_date", "is", null)
      .gte("sale_date", fromDate)
      .lte("sale_date", toDate)
      .order("sale_date", { ascending: false })
      .limit(limit);
    const { data, error } = await filterComparisonScope(query, scope, referenceSaleId);
    if (error) throw error;
    return (data ?? []) as Row[];
  };

  const [narrowest, ...wider] = comparisonScopes(base);
  if (!narrowest) {
    throw new PublicApiError(
      "La vente de référence n'a ni ville, ni département, ni tribunal, ni type de bien : aucun périmètre de comparaison.",
      400,
    );
  }
  let selected = { scope: narrowest, rows: await read(narrowest) };
  for (const scope of wider) {
    if (selected.rows.length >= minRows) break;
    selected = { scope, rows: await read(scope) };
  }
  return selected;
}
