import "server-only";
import { departmentCode } from "@/lib/department-code";
import { firstSearchToUrl } from "@/lib/onboarding";
import { lookupPublicSale } from "@/lib/public-sale.server";

const SALE_ID_IN_PATH = /^\/sales\/([^/?#]+)/;

/**
 * Secteur prérempli de la première recherche quand l'inscription part d'une fiche : le département
 * de la vente (« 33 », « 2A », « 974 »), lu comme pour un visiteur. Chaîne vide si la fiche, la base
 * ou le département manquent : la personne remplit alors le secteur elle-même.
 */
export async function onboardingAreaForSale(returnTo: string | undefined): Promise<string> {
  const id = returnTo ? SALE_ID_IN_PATH.exec(returnTo)?.[1] : undefined;
  if (!id) return "";
  try {
    const lookup = await lookupPublicSale(decodeURIComponent(id));
    if (lookup.status !== "found") return "";
    const code = departmentCode(lookup.sale.department);
    // Seul un département que la première recherche reconnaît comme tel (et que l'alerte gratuite
    // accepte) est prérempli.
    return code && firstSearchToUrl({ area: code, maxPrice: "", homeType: "" }).department === code
      ? code
      : "";
  } catch {
    // Une base injoignable ne bloque pas l'accueil : le secteur reste à saisir.
    return "";
  }
}
