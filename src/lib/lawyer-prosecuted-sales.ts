import {
  normalizeLawyerIdentity,
  resolveCnbDatasetBarKey,
  tribunalBarAssociation,
} from "@/lib/lawyer-bar";

/**
 * Ventes à venir où un avocat référencé est l'avocat poursuivant (point 72b) : rapprochement du
 * nom de l'avocat de l'annuaire et du champ `auction_sales.lawyer_name`.
 *
 * Ce champ est du texte libre repris de l'annonce. Un rapprochement faux afficherait sur la fiche
 * d'un avocat des ventes qui ne sont pas les siennes : il est donc volontairement BEAUCOUP plus
 * strict que `isProsecutingLawyer` (lawyer-bar.ts), qui reste large parce qu'il sert à EXCLURE un
 * avocat (un faux positif y est sans danger). Ici, un faux négatif (une vente non affichée) est
 * sans conséquence ; un faux positif ne l'est pas. Une vente est rattachée à un avocat seulement si
 * toutes ces conditions sont réunies :
 *
 *  1. le nom de l'annonce désigne UNE personne : ni société ni cabinet (SCP, SELARL, « Cabinet »,
 *     « associés »…), ni plusieurs noms (« et », « & », virgule, point-virgule, barre oblique) ;
 *  2. après retrait des titres, des accents et de la ponctuation, les mots du nom de l'annonce et
 *     ceux du nom de l'avocat sont les MÊMES, dans n'importe quel ordre (« DUPONT Jean » = « Jean
 *     Dupont »), sans mot en trop ni en moins ;
 *  3. ce nom compte au moins deux mots d'au moins deux lettres : jamais un patronyme seul
 *     (« Me Dupont ») ni une initiale (« J. Dupont »), trop courants ;
 *  4. le barreau de l'avocat est celui du tribunal judiciaire de la vente (le siège est lu dans
 *     le libellé du tribunal ; sans siège lisible, pas de rapprochement) : deux homonymes de
 *     barreaux différents ne sont jamais confondus ;
 *  5. aucun autre avocat référencé du même barreau n'a le même nom (homonymes : aucun des deux
 *     n'est rapproché).
 *
 * Limite connue : un homonyme exact du même barreau qui ne figure pas parmi les avocats référencés
 * ne peut pas être écarté. La fiche le dit : rapprochement automatique, à vérifier sur l'annonce.
 */

/** Mots qui désignent une société, un cabinet ou plusieurs personnes : pas d'identité unique. */
const NOT_A_SINGLE_PERSON =
  /\b(?:scp|selarl|selas|selafa|selurl|sarl|sas|aarpi|cabinet|associes?|avocats|societe|etude|office|et)\b|[&/;,+]/;

/** Nombre maximal de ventes montrées par avocat (les plus proches par date). */
export const MAX_PROSECUTED_SALES_PER_LAWYER = 5;

export type LawyerDirectorySale = {
  id: string;
  /** Ville du bien. */
  city: string | null;
  propertyType: string | null;
  /** Date de l'audience (ISO). */
  saleDate: string | null;
  startingPriceEur: number | null;
  /** Tribunal judiciaire qui juge la vente. */
  tribunalName: string | null;
};

export type LawyerUpcomingSales = {
  /** Au plus `MAX_PROSECUTED_SALES_PER_LAWYER` ventes, les plus proches d'abord. */
  sales: LawyerDirectorySale[];
  /** Nombre de ventes publiques rapprochées, avant ce plafond. */
  total: number;
};

export type ProsecutionLawyer = {
  id: string;
  displayName: string;
  barAssociation: string | null;
};

export type ProsecutionSaleCandidate = {
  id: string;
  lawyerName: string | null;
  tribunal: string | null;
  saleDate: string | null;
};

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Clé d'identité d'une personne : ses mots (titres, accents et ponctuation retirés) triés, ou
 * `null` quand le nom ne désigne pas de façon sûre une seule personne (conditions 1 et 3).
 */
export function personIdentityKey(name: string | null | undefined): string | null {
  if (!name) return null;
  if (NOT_A_SINGLE_PERSON.test(stripAccents(name))) return null;
  const tokens = normalizeLawyerIdentity(name)
    .split(" ")
    .filter((token) => token.length > 0);
  if (tokens.length < 2 || tokens.some((token) => token.length < 2)) return null;
  return [...tokens].sort().join(" ");
}

/** Identité d'un avocat dans son barreau : nom et barreau doivent tous deux être lisibles. */
function lawyerBarIdentity(lawyer: ProsecutionLawyer): string | null {
  const key = personIdentityKey(lawyer.displayName);
  const barKey = resolveCnbDatasetBarKey(lawyer.barAssociation);
  return key && barKey ? `${key}|${barKey}` : null;
}

function saleBarIdentity(sale: ProsecutionSaleCandidate): string | null {
  const key = personIdentityKey(sale.lawyerName);
  const barKey = resolveCnbDatasetBarKey(tribunalBarAssociation(sale.tribunal));
  return key && barKey ? `${key}|${barKey}` : null;
}

/**
 * Identifiants des ventes rattachées à chaque avocat (conditions ci-dessus), triés par date de
 * vente puis par identifiant. Un avocat sans vente rattachée n'a pas d'entrée.
 */
export function matchProsecutedSales(
  lawyers: readonly ProsecutionLawyer[],
  sales: readonly ProsecutionSaleCandidate[],
): Map<string, string[]> {
  const lawyersByIdentity = new Map<string, string[]>();
  for (const lawyer of lawyers) {
    const identity = lawyerBarIdentity(lawyer);
    if (!identity) continue;
    lawyersByIdentity.set(identity, [...(lawyersByIdentity.get(identity) ?? []), lawyer.id]);
  }

  const matched = new Map<string, ProsecutionSaleCandidate[]>();
  for (const sale of sales) {
    const identity = saleBarIdentity(sale);
    const owners = identity ? lawyersByIdentity.get(identity) : undefined;
    // Homonymes dans le même barreau (condition 5) : aucun rapprochement.
    if (!owners || owners.length !== 1) continue;
    matched.set(owners[0], [...(matched.get(owners[0]) ?? []), sale]);
  }

  const result = new Map<string, string[]>();
  for (const [lawyerId, lawyerSales] of matched) {
    result.set(
      lawyerId,
      [...lawyerSales]
        .sort(
          (left, right) =>
            (left.saleDate ?? "").localeCompare(right.saleDate ?? "") ||
            left.id.localeCompare(right.id),
        )
        .map((sale) => sale.id),
    );
  }
  return result;
}
