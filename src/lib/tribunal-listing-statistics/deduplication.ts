import "server-only";
import { normalizeOccupationStatus } from "@/lib/tribunal-listing-statistics";
import {
  normalizeLabel,
  normalizeLegalReference,
  positive,
  type StoredListingSale,
} from "@/lib/tribunal-listing-statistics/shared";

export function deduplicateTribunalListingSales(sales: StoredListingSale[]): {
  sales: StoredListingSale[];
  unresolvedStrongAddressDuplicates: number;
} {
  const parent = sales.map((_, index) => index);
  const groupMembers = new Map<number, number[]>(sales.map((_, index) => [index, [index]]));
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const canJoinGroups = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    const leftMembers = groupMembers.get(leftRoot) ?? [leftRoot];
    const rightMembers = groupMembers.get(rightRoot) ?? [rightRoot];
    return leftMembers.every((leftIndex) =>
      rightMembers.every((rightIndex) =>
        canMergeSaleIdentity(sales[leftIndex]!, sales[rightIndex]!),
      ),
    );
  };
  const canJoinLegalReferenceGroups = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    const leftMembers = groupMembers.get(leftRoot) ?? [leftRoot];
    const rightMembers = groupMembers.get(rightRoot) ?? [rightRoot];
    const everyFactualGuardPasses = leftMembers.every((leftIndex) =>
      rightMembers.every((rightIndex) =>
        canMergeSaleIdentity(sales[leftIndex]!, sales[rightIndex]!),
      ),
    );
    if (!everyFactualGuardPasses) return false;
    // At least one cross-group pair must carry the legal proof. Other
    // observations (for example Vench) may be part of the already grouped
    // announcement without exposing a Ref./RG of their own.
    return leftMembers.some((leftIndex) =>
      rightMembers.some((rightIndex) =>
        canMergeLegalReferenceIdentity(sales[leftIndex]!, sales[rightIndex]!),
      ),
    );
  };
  const union = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    if (!canJoinGroups(leftRoot, rightRoot)) return false;
    parent[rightRoot] = leftRoot;
    groupMembers.set(leftRoot, [
      ...(groupMembers.get(leftRoot) ?? [leftRoot]),
      ...(groupMembers.get(rightRoot) ?? [rightRoot]),
    ]);
    groupMembers.delete(rightRoot);
    return true;
  };

  // The source adapters persist two useful identity signals which are not
  // necessarily represented by the canonical row id: repeated observations
  // from one source can retain the same external id/content hash, while PA
  // and Vench intentionally expose the same source announcement id. Scope
  // each key to its source family and keep the existing factual guards below.
  const identityOwners = new Map<string, number[]>();
  for (let index = 0; index < sales.length; index += 1) {
    const sale = sales[index]!;

    const sameSourceKeys = [sourceExternalIdentityKey(sale), sourceContentHashKey(sale)].filter(
      (value): value is string => value != null,
    );
    for (const key of sameSourceKeys) {
      const owners = identityOwners.get(key) ?? [];
      const owner = owners.find((ownerIndex) => canJoinGroups(ownerIndex, index));
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(key, owners);
    }

    const sharedKey = sharedPaVenchIdentityKey(sale);
    if (sharedKey) {
      const owners = identityOwners.get(sharedKey) ?? [];
      const owner = owners.find(
        (ownerIndex) =>
          sourceFamily(sales[ownerIndex]!.sourceName) !== sourceFamily(sale.sourceName) &&
          canJoinGroups(ownerIndex, index),
      );
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(sharedKey, owners);
    }

    // Source URLs remain the strongest alias when they are available. Keep
    // their exact canonicalization in the same guarded identity pass.
    for (const url of sale.sourceUrls ?? []) {
      const key = canonicalUrl(url);
      if (!key) continue;
      const owners = identityOwners.get(`url:${key}`) ?? [];
      const owner = owners.find((ownerIndex) => canJoinGroups(ownerIndex, index));
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(`url:${key}`, owners);
    }

    // PA Ref. and Enchères Immobilières RG are a court-issued identity
    // signal. Reapply every factual guard at group level so a shared
    // reference cannot bridge different hearings, cities or prices.
    const legalKey = legalReferenceIdentityKey(sale);
    if (legalKey) {
      const owners = identityOwners.get(legalKey) ?? [];
      const owner = owners.find(
        (ownerIndex) =>
          legalReferenceSourcePair(sales[ownerIndex]!, sale) &&
          canJoinLegalReferenceGroups(ownerIndex, index),
      );
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(legalKey, owners);
    }
  }

  const addressBuckets = new Map<string, number[]>();
  let unresolvedStrongAddressDuplicates = 0;
  for (let index = 0; index < sales.length; index += 1) {
    const sale = sales[index]!;
    const key = strongAddressDateKey(sale);
    if (!key) continue;
    const candidates = addressBuckets.get(key) ?? [];
    let merged = false;
    let ambiguous = false;
    for (const candidateIndex of candidates) {
      if (!canJoinGroups(candidateIndex, index)) {
        ambiguous = true;
        continue;
      }
      if (union(candidateIndex, index)) {
        merged = true;
        break;
      }
      ambiguous = true;
    }
    candidates.push(index);
    addressBuckets.set(key, candidates);
    if (!merged && ambiguous) unresolvedStrongAddressDuplicates += 1;
  }

  const groups = new Map<number, StoredListingSale[]>();
  for (let index = 0; index < sales.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(sales[index]!);
    groups.set(root, group);
  }
  return {
    sales: [...groups.values()].map(mergeSaleGroup),
    unresolvedStrongAddressDuplicates,
  };
}

function sourceExternalIdentityKey(sale: StoredListingSale): string | null {
  const source = sourceFamily(sale.sourceName);
  const externalId = normalizeExternalId(sale.externalId);
  if (!source || !externalId) return null;
  return `external:${source}:${externalId}`;
}

function sourceContentHashKey(sale: StoredListingSale): string | null {
  const source = sourceFamily(sale.sourceName);
  const contentHash = normalizeExternalId(sale.contentHash);
  if (!source || !contentHash) return null;
  return `content:${source}:${contentHash}`;
}

function sharedPaVenchIdentityKey(sale: StoredListingSale): string | null {
  const source = sourceFamily(sale.sourceName);
  const externalId = normalizeExternalId(sale.externalId);
  if (!externalId || (source !== "petitesaffiches" && source !== "vench")) return null;
  return `shared-pa-vench:${externalId}`;
}

function legalReferenceIdentityKey(sale: StoredListingSale): string | null {
  const reference = normalizeLegalReference(sale.legalReference);
  const source = sourceFamily(sale.sourceName);
  if (!reference || (source !== "petitesaffiches" && source !== "encheresimmobilieres")) {
    return null;
  }
  return `legal:${reference}`;
}

function legalReferenceSourcePair(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftSource = sourceFamily(left.sourceName);
  const rightSource = sourceFamily(right.sourceName);
  return (
    leftSource !== rightSource &&
    [leftSource, rightSource].every(
      (source) => source === "petitesaffiches" || source === "encheresimmobilieres",
    )
  );
}

export function sourceFamily(value: string | null | undefined): string {
  return normalizeLabel(value ?? "").replace(/\s+/g, "");
}

function normalizeExternalId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  return normalized ? normalized : null;
}

export function deduplicateListingSales(sales: StoredListingSale[]) {
  return deduplicateTribunalListingSales(sales);
}

function mergeSaleGroup(group: StoredListingSale[]): StoredListingSale {
  const ordered = [...group].sort(
    (left, right) =>
      saleRichnessScore(right) - saleRichnessScore(left) || left.id.localeCompare(right.id),
  );
  const winner = ordered[0]!;
  const names = [...new Set(group.flatMap((sale) => sale.sourceNames ?? []))].sort((a, b) =>
    a.localeCompare(b, "fr"),
  );
  const urls = [...new Set(group.flatMap((sale) => sale.sourceUrls ?? []))];
  const firstWith = <K extends keyof StoredListingSale>(key: K): StoredListingSale[K] => {
    for (const sale of ordered) {
      const value = sale[key];
      if (value != null && value !== "") return value;
    }
    return winner[key];
  };
  return {
    ...winner,
    title: firstWith("title"),
    city: firstWith("city"),
    address: firstWith("address"),
    identityAddress: firstKnownIdentityAddress(group) ?? firstWith("identityAddress"),
    legalReference: firstWith("legalReference"),
    sourceName: winner.sourceName,
    sourceNames: names,
    sourceUrls: urls,
    saleDate: firstWith("saleDate"),
    startingPriceEur: firstWith("startingPriceEur"),
    propertyType: firstKnownPropertyType(group) ?? firstWith("propertyType"),
    visitDates: unionVisitDates(group),
    occupancyStatus: firstKnownOccupancy(group) ?? firstWith("occupancyStatus"),
    lawyerName: firstWith("lawyerName"),
    publicationAt: earliestDate(group.map((sale) => sale.publicationAt)),
    firstSeenAt: earliestDate(group.map((sale) => sale.firstSeenAt)),
    overbidStatus: firstWith("overbidStatus"),
    overbidEvidence: group.flatMap((sale) =>
      Array.isArray(sale.overbidEvidence) ? sale.overbidEvidence : [],
    ),
    marketEstimate: firstWith("marketEstimate"),
    marketEstimateEligible: group.some((sale) => sale.marketEstimateEligible === true),
  };
}

function saleRichnessScore(sale: StoredListingSale): number {
  const fields = [
    sale.title,
    sale.address,
    sale.city,
    sale.saleDate,
    sale.startingPriceEur,
    sale.propertyType && isKnownPropertyType(sale.propertyType) ? sale.propertyType : null,
    sale.occupancyStatus && normalizeOccupationStatus(sale.occupancyStatus)
      ? sale.occupancyStatus
      : null,
    sale.lawyerName,
    sale.publicationAt,
    sale.firstSeenAt,
  ];
  const fieldScore = fields.reduce<number>(
    (score, value) => score + (value != null && value !== "" ? 1 : 0),
    0,
  );
  const visitScore = Array.isArray(sale.visitDates) && sale.visitDates.length > 0 ? 1 : 0;
  const sourcePriority = Math.max(
    ...(sale.sourceNames ?? []).map((source) => {
      const normalized = source.toLocaleLowerCase("fr-FR");
      if (normalized.includes("avovente")) return 4;
      if (normalized.includes("petitesaffiche")) return 3;
      if (normalized.includes("vench")) return 2;
      if (normalized.includes("licitor")) return 1;
      return 0;
    }),
    0,
  );
  return fieldScore * 10 + visitScore + sourcePriority;
}

function firstKnownPropertyType(group: StoredListingSale[]): string | null {
  return group.find((sale) => isKnownPropertyType(sale.propertyType))?.propertyType ?? null;
}

function firstKnownOccupancy(group: StoredListingSale[]): string | null {
  return (
    group.find((sale) => normalizeOccupationStatus(sale.occupancyStatus))?.occupancyStatus ?? null
  );
}

function isKnownPropertyType(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  return Boolean(normalized && normalized !== "unknown");
}

function unionVisitDates(group: StoredListingSale[]): unknown[] {
  const values = group.flatMap((sale) => (Array.isArray(sale.visitDates) ? sale.visitDates : []));
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function earliestDate(values: Array<string | null | undefined>): string | null {
  const dates = values
    .map((value) => (value ? new Date(value) : null))
    .filter((value): value is Date => value != null && Number.isFinite(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0]?.toISOString() ?? null;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLocaleLowerCase("fr-FR");
  } catch {
    return value.trim().toLocaleLowerCase("fr-FR");
  }
}

function conflictingLot(left: StoredListingSale, right: StoredListingSale): boolean {
  if (left.lotNumber != null && right.lotNumber != null) {
    return left.lotNumber !== right.lotNumber;
  }
  // A multi-lot source row cannot be safely matched to a row without the
  // same lot evidence: the latter may describe only one of its lots.
  return isMultiLot(left.lotNumber) || isMultiLot(right.lotNumber);
}

function identityAddressFingerprint(sale: StoredListingSale): string | null {
  return strongAddressFingerprint(sale.identityAddress ?? sale.address, sale.city);
}

function conflictingIdentityAddress(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftAddress = identityAddressFingerprint(left);
  const rightAddress = identityAddressFingerprint(right);
  return leftAddress != null && rightAddress != null && leftAddress !== rightAddress;
}

function conflictingLegalReference(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftReference = normalizeLegalReference(left.legalReference);
  const rightReference = normalizeLegalReference(right.legalReference);
  return leftReference != null && rightReference != null && leftReference !== rightReference;
}

function canMergeSaleIdentity(left: StoredListingSale, right: StoredListingSale): boolean {
  if (conflictingLot(left, right)) return false;
  if (conflictingIdentityAddress(left, right)) return false;
  if (conflictingLegalReference(left, right)) return false;
  if (!sameKnownCity(left.city, right.city)) return false;
  if (!sameKnownHearingDay(left.saleDate, right.saleDate)) return false;
  if (!samePositiveStartingPrice(left.startingPriceEur, right.startingPriceEur)) return false;
  if (!sameKnownPropertyClass(left.propertyType, right.propertyType)) return false;
  if (materiallyDifferentSurface(left, right)) return false;
  return true;
}

function canMergeLegalReferenceIdentity(
  left: StoredListingSale,
  right: StoredListingSale,
): boolean {
  const leftReference = normalizeLegalReference(left.legalReference);
  const rightReference = normalizeLegalReference(right.legalReference);
  if (!leftReference || leftReference !== rightReference) return false;
  if (!legalReferenceSourcePair(left, right)) return false;

  const leftCity = left.city ? normalizeLabel(left.city) : "";
  const rightCity = right.city ? normalizeLabel(right.city) : "";
  if (!leftCity || !rightCity || leftCity !== rightCity) return false;

  const leftDay = left.saleDate ? parseDay(left.saleDate) : null;
  const rightDay = right.saleDate ? parseDay(right.saleDate) : null;
  if (!leftDay || !rightDay || leftDay !== rightDay) return false;
  if (!positive(left.startingPriceEur) || !positive(right.startingPriceEur)) return false;
  if (!sameStartingPrice(left.startingPriceEur, right.startingPriceEur)) return false;
  return canMergeSaleIdentity(left, right);
}

function isMultiLot(value: string | null | undefined): boolean {
  return value?.startsWith("multi:") ?? false;
}

function sameKnownCity(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftCity = left ? normalizeLabel(left) : "";
  const rightCity = right ? normalizeLabel(right) : "";
  return !leftCity || !rightCity || leftCity === rightCity;
}

function sameKnownHearingDay(left: string | null, right: string | null): boolean {
  const leftDay = left ? parseDay(left) : null;
  const rightDay = right ? parseDay(right) : null;
  return leftDay == null || rightDay == null || leftDay === rightDay;
}

function samePositiveStartingPrice(left: number | null, right: number | null): boolean {
  return (
    left == null ||
    right == null ||
    !positive(left) ||
    !positive(right) ||
    sameStartingPrice(left, right)
  );
}

function sameKnownPropertyClass(left: string | null | undefined, right: string | null | undefined) {
  const leftClass = propertyClass(left);
  const rightClass = propertyClass(right);
  return leftClass == null || rightClass == null || leftClass === rightClass;
}

function propertyClass(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return null;
  if (/appartement|apartment|studio|loft/.test(normalized)) return "apartment";
  if (/maison|house|villa|pavillon/.test(normalized)) return "house";
  // The source vocabulary for parking, garages, buildings and commercial
  // units is not stable enough to make those labels identity conflicts.
  return "other";
}

function materiallyDifferentSurface(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftSource = left.valuationSource ?? {};
  const rightSource = right.valuationSource ?? {};
  for (const key of [
    "app_surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
  ]) {
    const leftValue = positiveNumberFromUnknown(leftSource[key]);
    const rightValue = positiveNumberFromUnknown(rightSource[key]);
    if (leftValue == null || rightValue == null) continue;
    const difference = Math.abs(leftValue - rightValue);
    const tolerance = Math.max(5, Math.max(leftValue, rightValue) * 0.1);
    if (difference > tolerance) return true;
  }
  return false;
}

function positiveNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const number = Number(value);
    return number > 0 ? number : null;
  }
  return null;
}

function strongAddressDateKey(sale: StoredListingSale): string | null {
  const address = identityAddressFingerprint(sale);
  const city = sale.city ? normalizeLabel(sale.city) : "";
  const date = sale.saleDate ? parseDay(sale.saleDate) : null;
  if (!address || !city || !date) return null;
  return `${address}|${city}|${date}`;
}

function firstKnownIdentityAddress(group: StoredListingSale[]): string | null {
  return (
    group.find((sale) => identityAddressFingerprint(sale) != null)?.identityAddress ??
    group.find((sale) => strongAddressFingerprint(sale.address, sale.city) != null)?.address ??
    null
  );
}

function strongAddressFingerprint(
  value: string | null | undefined,
  city?: string | null,
): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeAddressLabel(value)
    .replace(/\b\d{5}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedCity = city ? normalizeAddressLabel(city) : "";
  const addressWithoutCity =
    normalizedCity && normalized.endsWith(` ${normalizedCity}`)
      ? normalized.slice(0, -normalizedCity.length).trim()
      : normalized;
  const number = /\b\d+[a-z]?\b/.exec(normalized)?.[0];
  const words = addressWithoutCity.split(" ").filter(Boolean);
  if (!number || words.length < 3) return null;
  const street = words
    .filter(
      (word) => word !== number && !["d", "de", "du", "des", "la", "le", "les"].includes(word),
    )
    .join(" ");
  if (!/[a-z]/.test(street)) return null;
  return `${number}|${street}`;
}

function normalizeAddressLabel(value: string): string {
  return normalizeLabel(
    value
      .replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, "$1 $2")
      .replace(/([0-9])([A-Za-zÀ-ÿ])/g, "$1 $2")
      .replace(/([A-Za-zÀ-ÿ])([0-9])/g, "$1 $2"),
  );
}

function parseDay(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function sameStartingPrice(left: number | null, right: number | null): boolean {
  if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right))
    return false;
  return Math.round(left * 100) === Math.round(right * 100);
}
