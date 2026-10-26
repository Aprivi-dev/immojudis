import "server-only";
import { parseOpenFeeRegimes } from "@/lib/fee-regime";
import { ceilingScopeNoteText } from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";

/**
 * Les régimes de frais dont le plafond est ouvert, lus dans `CEILING_FEE_REGIMES_OPEN` côté
 * serveur : la fiche de la vente, le rapport enregistré et son PDF s'appuient tous sur cette lecture
 * (voir `parseOpenFeeRegimes` : variable absente, tous les régimes définis ; présente, ceux qu'elle
 * liste, le tribunal toujours).
 */
export function openFeeRegimesFromEnv(
  env: Record<string, string | undefined> = process.env,
): FeeRegimeKey[] {
  return parseOpenFeeRegimes(env.CEILING_FEE_REGIMES_OPEN);
}

/**
 * Ce que les composants du navigateur ont besoin de savoir de l'interrupteur par régime : les
 * régimes ouverts (cartes de résultats) et la note qui dit où le plafond existe (accueil du compte).
 * Lu sur le serveur et passé à `FeeRegimesProvider` ; le texte est composé ici pour ne pas embarquer
 * le vocabulaire des régimes dans le navigateur.
 */
export function feeRegimesSettingsFromEnv(env: Record<string, string | undefined> = process.env): {
  open: FeeRegimeKey[];
  scopeNote: string;
} {
  const open = openFeeRegimesFromEnv(env);
  return { open, scopeNote: ceilingScopeNoteText(open) };
}
