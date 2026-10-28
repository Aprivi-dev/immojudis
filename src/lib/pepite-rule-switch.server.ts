import "server-only";
import { serverEnv, type EnvSource } from "@/lib/env";
import {
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_1_RULE_VERSION,
  type PepiteRuleVersion,
} from "@/lib/pepite-policy";

/**
 * Interrupteur serveur de la règle `pepite-v2` (critère éliminatoire du risque d'inondation).
 *
 * `PEPITE_RULE_V2_ENABLED` : absente ou autre chose que `true` / `1` -> FERMÉ (défaut) : la règle APPLIQUÉE reste
 * `pepite-v1.1` (la règle d'origine corrigée le 27/10/2026 ; `pepite-v1`, remplacée, reste rejouable). Le
 * traitement des pépites ne lit alors pas la table d'inondation, pendant que
 * le traitement d'inondation (`/api/cron/sale-flood-risk`) s'alimente et se calibre. Une fois la calibration faite,
 * la bascule est un seul geste : définir `PEPITE_RULE_V2_ENABLED=true` dans l'environnement du serveur et
 * redéployer ; le retour arrière est le même geste inverse (voir `docs/operations/planification.md`).
 *
 * Seul le serveur lit l'interrupteur (le navigateur ne le voit pas) ; la page de méthode et le traitement des
 * pépites s'y réfèrent par les fonctions ci-dessous.
 */
export const PEPITE_RULE_V2_ENV = "PEPITE_RULE_V2_ENABLED";

export function pepiteV2EnabledFromEnv(env: EnvSource = process.env): boolean {
  // Lecture par le circuit de configuration commun (`serverEnv`, valeur nettoyée des espaces).
  const value = (serverEnv(env).pepiteRule.v2Enabled ?? "").toLowerCase();
  return value === "true" || value === "1";
}

/** La version de la règle appliquée : `pepite-v2` si l'interrupteur est ouvert, sinon `pepite-v1.1`. */
export function activePepiteRuleVersion(env: EnvSource = process.env): PepiteRuleVersion {
  return pepiteV2EnabledFromEnv(env) ? PEPITE_LATEST_RULE_VERSION : PEPITE_V1_1_RULE_VERSION;
}
