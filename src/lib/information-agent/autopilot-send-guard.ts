import "server-only";
import { PublicApiError } from "@/lib/api-errors";
import {
  informationAgentAddressHygieneIssue,
  isConsumerMailAddress,
} from "@/lib/information-agent/address-hygiene";
import { informationAgentAddressCheckEnabled } from "@/lib/information-agent/address-deliverability";
import {
  loadAutopilotHistoryFacts,
  loadAutopilotRegistryFacts,
} from "@/lib/information-agent/autopilot-facts";
import { evaluateAutopilotSendTime } from "@/lib/information-agent/autopilot-rules";
import { personIdentityKeys } from "@/lib/information-agent/opposition-keys";
import {
  loadAutopilotSettings,
  loadExcludedIdentityKeys,
} from "@/lib/information-agent/autopilot-settings";

/**
 * Refus du pilote au moment de l'envoi : une règle revérifiée ne tient plus, ou le pilote n'est plus en mode réel
 * (`not_live`, levé ici ou par le filet SQL de la garde des missions). Une décision, jamais une erreur d'API :
 * l'exécuteur la journalise à part et ne la compte pas parmi les erreurs consécutives du fournisseur.
 */
export class AutopilotSendRefusedError extends PublicApiError {
  /** Code du motif (`not_live`, `identity_excluded`, `reply_pause`…). */
  readonly refusal: string;

  constructor(refusal: string, options: { cause?: unknown } = {}) {
    super(`Envoi automatique refusé (${refusal}) : validation manuelle requise.`, 409, options);
    this.name = "AutopilotSendRefusedError";
    this.refusal = refusal;
  }
}

/**
 * Revérification des règles du pilote JUSTE AVANT l'envoi (déclencheur `autopilot` seulement) : l'état a pu changer
 * entre la sélection et l'envoi (origine de l'adresse, identité exclue, réponse reçue, pilote coupé…).
 *
 * Sont imposés : pilote en mode réel, ni greffe de secours ni autre origine que l'annonce (la VRAIE origine
 * résolue, et aucune autre origine enregistrée pour cette adresse et cette vente), destinataire de rôle avocat,
 * ni messagerie grand public, aucune identité exclue, pauses de 90 jours et de 6 mois, article 14, adresses
 * Licitor décodées sous réserve du réglage, date de relevé présente et récente. Une origine absente est un refus.
 */
export async function assertAutopilotSendAllowed({
  saleId,
  email,
  identityKeys,
  recipientKind,
  addressOriginKind,
  courtFallback,
  now = new Date(),
}: {
  saleId: string;
  email: string;
  identityKeys: readonly string[];
  recipientKind: string;
  addressOriginKind: string | null;
  courtFallback: boolean;
  now?: Date;
}): Promise<void> {
  const refuse = (code: string): never => {
    throw new AutopilotSendRefusedError(code);
  };
  const settings = await loadAutopilotSettings();
  if (settings.mode !== "live") refuse("not_live");
  if (courtFallback) refuse("court_registry_refused");
  const normalized = email.trim().toLowerCase();
  const [registry, history, excluded] = await Promise.all([
    loadAutopilotRegistryFacts(normalized, saleId),
    loadAutopilotHistoryFacts(normalized, identityKeys, now),
    loadExcludedIdentityKeys(identityKeys),
  ]);
  const otherOrigin = registry.originKinds.some((kind) => kind !== "sale_listing");
  const check = informationAgentAddressCheckEnabled();
  const verdict = evaluateAutopilotSendTime(
    {
      sourceKind: otherOrigin ? "multiple_origins" : addressOriginKind,
      recipientRole: recipientKind === "source_lawyer" ? "lawyer" : recipientKind,
      // Une clé de structure (adresse générique) n'identifie pas le professionnel : elle ne compte pas.
      identityComplete: personIdentityKeys(identityKeys).length > 0,
      addressHygieneIssue: check ? informationAgentAddressHygieneIssue(normalized) : null,
      consumerDomain: isConsumerMailAddress(normalized),
      observationChannel: registry.licitorDecoded ? "licitor_cloudflare_decoded" : null,
      addressObservedAt: registry.observedAt,
      identityExcluded: excluded.size > 0,
      contactFirstRecordedAt: registry.firstRecordedAt,
      ...history,
    },
    settings,
    now,
  );
  if (!verdict.ok) refuse(verdict.code);
}
