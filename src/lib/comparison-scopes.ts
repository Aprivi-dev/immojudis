import { propertyFamily } from "@/lib/property-type-family";

/**
 * Périmètres des ventes de comparaison d'une vente (ventes actives du rapport) : du plus étroit au
 * plus large, chacun nommé par les critères qu'il pose.
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
 * départements différents portent le même nom. Le type seul, partout en France, ferme la cascade ;
 * sans lieu connu, c'est le seul périmètre.
 *
 * Un type inconnu ou « autre » n'est pas un critère (`matchesPropertyFamily`) : « unknown » ne dit
 * rien du bien, et deux biens « other » ne se ressemblent pas pour autant.
 */
export function comparisonScopes(base: ComparisonBase): ComparisonScope[] {
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
  if (propertyType) scopes.push(scope({ propertyType }));

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
