import "server-only";
import { PublicApiError } from "@/lib/api-errors";
import { assertAdmin } from "@/lib/admin-auth.server";
import type { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { getPublishedInformationAgentEmailTemplate } from "@/lib/admin-information-agent-email-template";
import { loadAdminInformationAgentSale } from "@/lib/admin-information-agent-sale";
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import {
  getFactReliabilitiesFromClaims,
  getKeyFactReliabilities,
  type FactReliabilityMap,
} from "@/lib/fact-reliability";
import { formatDate, formatStartingPrice } from "@/lib/format";
import { formatInformationAgentOriginDate } from "@/lib/information-agent-compliance";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
  type InformationAgentEmailTemplateContent,
} from "@/lib/information-agent-email-template";
import {
  buildInformationAgentInventory,
  informationAgentInventorySnapshot,
  type InformationAgentInventory,
  type InformationAgentInventorySale,
} from "@/lib/information-agent-inventory";
import {
  detectInformationGaps,
  informationAgentQuestionContext,
  informationAgentQuestionText,
  selectDefaultInformationAgentQuestionKeys,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import {
  ADDRESS_NOT_RECORDED_MESSAGE,
  searchInformationAgentAddressForDraft,
} from "@/lib/information-agent/address-search";
import { informationAgentAppOrigin } from "@/lib/information-agent/config";
import { resolveInformationAgentListingContacts } from "@/lib/information-agent/contact-resolution";
import {
  informationAgentAddressKind,
  informationAgentOfficeCodeFor,
  isInformationAgentStructureKey,
} from "@/lib/information-agent/contact-structure";
import {
  recipientOppositionKeys,
  type InformationAgentRecipientOppositionKeys,
} from "@/lib/information-agent/opposition-keys";
import {
  INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE,
  informationAgentQuestionAudience,
  informationAgentQuestionTextFor,
  isInformationAgentQuestionAllowed,
  type InformationAgentQuestionAudience,
} from "@/lib/information-agent/recipient-questions";
import { informationAgentAudienceTemplate } from "@/lib/information-agent/recipient-templates";
import {
  assertInformationAgentContactAllowed,
  INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE,
  INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE,
  loadOpposedInformationAgentIdentityKeys,
  persistInformationAgentContactObservations,
} from "@/lib/information-agent/contacts";
import {
  contactCandidateSnapshot,
  selectInformationAgentContact,
} from "@/lib/information-agent/contact-resolution";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { INFORMATION_AGENT_COURT_REGISTRY_FALLBACK } from "@/lib/information-agent/court-registry-fallback";
import {
  assertCourtRegistryDraftAllowed,
  COURT_REGISTRY_DRAFT_OPTIONS,
  courtRegistryDraftMetadata,
  findCourtRegistryFallbackForDraft,
} from "@/lib/information-agent/court-registry-mission";
import {
  assertNoSentCaseForRecipient,
  shortenSubjectTitle,
  withoutProfessionSuffix,
  withSignature,
} from "@/lib/information-agent/draft-checks";
import { missingRecipientMessage } from "@/lib/information-agent/email-address";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import { saleIdentityPlace } from "@/lib/information-agent/mission-identity";
import {
  cancelMission,
  listFactsForCases,
  loadOwnedMission,
  missionFromRow,
} from "@/lib/information-agent/mission-store";
import type {
  informationAgentCreateSchema,
  InformationAgentAdminResponse,
  InformationAgentSendTrigger,
} from "@/lib/information-agent/schemas";
import { assertIssuedAutopilotTrigger } from "@/lib/information-agent/schemas";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { saleDisplayTitle } from "@/lib/sale-title";
import type { AuctionSale } from "@/lib/types";

// Construction du texte de la demande et création du brouillon d'une mission. Extraits de
// `information-agent.ts` sans changement de comportement ; l'envoi est dans `send.ts`.

export function buildInformationRequestDraft({
  sale,
  recipientName,
  questionKeys,
  facts,
  inventory,
  template = DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  signatureName = null,
  questionLines,
}: {
  sale: InformationAgentInventorySale;
  recipientName?: string | null;
  questionKeys: readonly InformationAgentQuestionKey[];
  facts?: FactReliabilityMap;
  inventory?: InformationAgentInventory;
  template?: InformationAgentEmailTemplateContent;
  /** Questions écrites telles quelles (message à un greffe) : remplacent celles des `questionKeys`. */
  questionLines?: readonly string[];
  /** Personne qui signe (`INFORMATION_AGENT_SIGNATURE_NAME`) : un nom rassure plus qu'une équipe. */
  signatureName?: string | null;
}): { subject: string; bodyText: string } {
  const resolvedInventory =
    inventory ?? buildInformationAgentInventory(sale, facts ?? getKeyFactReliabilities(sale));
  const questionContext = informationAgentQuestionContext(resolvedInventory);
  const title = saleDisplayTitle(sale, "Vente immobilière");
  const location = [sale.postal_code, sale.city].filter(Boolean).join(" ");
  const hearing = formatDate(sale.sale_date);
  const hearingStatus = facts?.sale_date.status;
  const priceStatus = facts?.starting_price_eur.status;
  const reference = [title, sale.address, location, sale.tribunal].filter(Boolean).join(" — ");
  const trimmedRecipientName = withoutProfessionSuffix(recipientName ?? "") ?? undefined;
  const hearingLabel = resolvedInventory.judicial ? "Audience annoncée" : "Date de vente annoncée";
  const shortHearing =
    hearing === "Date à confirmer" || hearingStatus === "conflict"
      ? null
      : formatInformationAgentOriginDate(sale.sale_date);
  const startingPrice =
    priceStatus === "conflict" || sale.starting_price_eur == null || sale.starting_price_eur <= 0
      ? null
      : formatStartingPrice(sale.starting_price_eur);
  const priceToConfirm = Boolean(priceStatus && priceStatus !== "observed");
  const rendered = renderInformationAgentEmailContent({
    template,
    values: {
      recipient_name: trimmedRecipientName || "Madame, Monsieur",
      salutation: trimmedRecipientName ? `Bonjour ${trimmedRecipientName},` : "Madame, Monsieur,",
      sale_title: title,
      sale_subject_title: shortenSubjectTitle(
        sale.city && !title.toLowerCase().includes(sale.city.toLowerCase())
          ? `${title} à ${sale.city}`
          : title,
      ),
      sale_reference: reference || title,
      location: location || "Localisation non précisée",
      tribunal: sale.tribunal || "Tribunal non précisé",
      hearing_date:
        hearingStatus === "conflict"
          ? "Date à confirmer"
          : hearing !== "Date à confirmer" && hearingStatus && hearingStatus !== "observed"
            ? `${hearing} (à confirmer)`
            : hearing,
      hearing_line:
        hearing === "Date à confirmer" || hearingStatus === "conflict"
          ? ""
          : hearingStatus && hearingStatus !== "observed"
            ? `${hearingLabel}, à confirmer : ${hearing}`
            : `${hearingLabel} : ${hearing}`,
      // L'objet nomme la date pour que le professionnel reconnaisse son dossier avant d'ouvrir.
      subject_date: shortHearing
        ? `${resolvedInventory.judicial ? "audience" : "vente"} du ${shortHearing}`
        : "date à confirmer",
      starting_price: !startingPrice
        ? "Mise à prix à confirmer"
        : priceToConfirm
          ? `${startingPrice} (à confirmer)`
          : startingPrice,
      price_line: !startingPrice
        ? ""
        : priceToConfirm
          ? `Mise à prix annoncée, à confirmer : ${startingPrice}`
          : `Mise à prix annoncée : ${startingPrice}`,
      questions: (
        questionLines ??
        questionKeys.map((key) => informationAgentQuestionText(key, questionContext))
      )
        .map((line) => `- ${line}`)
        .join("\n"),
    },
  });
  return { ...rendered, bodyText: withSignature(rendered.bodyText, signatureName) };
}

/**
 * Creates a mission for the internal admin enrichment workflow.
 *
 * This intentionally does not resolve plan entitlements, consume a user
 * rate-limit bucket, or create a requester subscription. The admin account is
 * the mission owner for traceability and the canonical case is still created
 * through the existing subscription RPC so inbound webhook routing remains
 * unchanged.
 */
export async function createAdminInformationAgentDraft({
  auth,
  input,
  trigger,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof informationAgentCreateSchema>;
  /** Pilote automatique : jamais de recherche réseau ni de greffe, mission marquée `trigger = autopilot`. */
  trigger?: InformationAgentSendTrigger;
}): Promise<InformationAgentAdminResponse> {
  assertAdmin(auth);
  assertIssuedAutopilotTrigger(trigger);

  const [sale, emailTemplate] = await Promise.all([
    loadAdminInformationAgentSale({ auth, saleId: input.saleId }),
    getPublishedInformationAgentEmailTemplate(),
  ]);
  const claimRead = await readSaleFactClaims(sale.id);
  const facts = getFactReliabilitiesFromClaims(sale, claimRead.claims);
  const inventory = buildInformationAgentInventory(sale, facts);
  const gaps = detectInformationGaps(sale, facts, inventory);
  const requestedQuestionKeys = input.questionKeys ? uniqueQuestionKeys(input.questionKeys) : null;
  // Les questions dépendent du destinataire (recipient-questions.ts) : elles sont arrêtées une fois celui-ci
  // connu. Sans lacune ni question choisie, rien n'est lu ni enregistré.
  if (!(requestedQuestionKeys ?? gaps).length) {
    throw new PublicApiError(INFORMATION_AGENT_NO_GAP_MESSAGE, 400);
  }
  // Opposition par identité, avant d'enregistrer ou de choisir la moindre adresse : un professionnel
  // opposé n'est plus sollicité sous une autre adresse, et son adresse n'est pas stockée.
  const identityPlace = saleIdentityPlace(sale);
  const resolution = resolveInformationAgentListingContacts(sale);
  // Clés d'opposition de chaque adresse (opposition-keys.ts) : celles qu'elle porte et celles à contrôler,
  // dont la structure. Une structure opposée écarte toutes ses adresses.
  const keysByEmail = new Map<string, InformationAgentRecipientOppositionKeys>();
  const discovered = resolution.candidates.map((candidate) => {
    const keys = recipientOppositionKeys({
      role: candidate.role,
      name: candidate.name ?? (candidate.role === "lawyer" ? sale.lawyer_name : null),
      place: identityPlace,
      email: candidate.email,
      officeCode: candidate.officeCode,
      addressKind: candidate.addressKind,
    });
    keysByEmail.set(candidate.email, keys);
    return { ...candidate, identityKeys: keys.identityKeys };
  });
  const checkKeysOf = (candidate: (typeof discovered)[number]) =>
    keysByEmail.get(candidate.email)?.checkKeys ?? candidate.identityKeys;
  const opposedKeys = new Set(
    await loadOpposedInformationAgentIdentityKeys(discovered.flatMap(checkKeysOf)),
  );
  const listingCandidates = discovered.filter(
    (candidate) => !checkKeysOf(candidate).some((key) => opposedKeys.has(key)),
  );
  const candidatesSkippedForOpposition = discovered.length - listingCandidates.length;
  const explicitRecipientEmail = normalizedEmail(input.recipientEmail);

  // Recherche autonome (niveau 1), sans adresse dans l'annonce ni saisie : elle ne fait que préparer.
  const search = await searchInformationAgentAddressForDraft({
    sale,
    identityPlace,
    siteOrigin: informationAgentAppOrigin(),
    skip: Boolean(explicitRecipientEmail) || discovered.length > 0 || Boolean(trigger),
  });
  const foundContact = search.candidate;
  const contactCandidates = foundContact ? [foundContact] : listingCandidates;
  await persistInformationAgentContactObservations({
    saleId: sale.id,
    candidates: foundContact ? [] : contactCandidates,
  });
  const selectedContact = foundContact ?? selectInformationAgentContact(contactCandidates);
  // Greffe de secours : vente au tribunal sans AUCUN destinataire avocat ou cabinet (court-registry-mission.ts).
  const courtFallback = await findCourtRegistryFallbackForDraft({
    sale,
    explicitRecipientEmail: explicitRecipientEmail ?? null,
    selectedContact,
    contactCandidates,
    candidatesSkippedForOpposition,
  });
  if (trigger && (courtFallback || foundContact)) {
    throw new PublicApiError(
      "Le pilote automatique n'écrit ni à un greffe ni à une adresse retrouvée par recherche.",
      409,
    );
  }
  const recipientEmail =
    explicitRecipientEmail ?? selectedContact?.email ?? courtFallback?.candidate.email;
  if (!recipientEmail) {
    if (candidatesSkippedForOpposition > 0 && !contactCandidates.length) {
      throw new PublicApiError(
        [...opposedKeys].some(isInformationAgentStructureKey)
          ? INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE
          : INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE,
        409,
      );
    }
    throw new PublicApiError(
      missingRecipientMessage(contactCandidates.length, search.noAddressNote),
      400,
    );
  }
  const selectedByEmail =
    courtFallback?.candidate ??
    contactCandidates.find((candidate) => candidate.email === recipientEmail);
  // A manual address or another source contact must not inherit the lawyer's
  // name: it can belong to a different professional entirely. Un greffe n'a pas de nom de personne.
  const recipientName = courtFallback
    ? null
    : (input.recipientName ?? withoutProfessionSuffix(selectedByEmail?.name ?? "") ?? null);
  const recipientIdentityRole = selectedByEmail?.role ?? null;
  const recipientOfficeCode = informationAgentOfficeCodeFor({
    email: recipientEmail,
    officeCode: selectedByEmail?.officeCode,
    saleOfficeCode: resolution.officeCode,
  });
  const recipientAddressKind =
    selectedByEmail?.addressKind ?? informationAgentAddressKind(recipientEmail);
  // Un greffe n'a ni identité de personne ni structure opposable : aucune clé.
  const recipientKeys: InformationAgentRecipientOppositionKeys = courtFallback
    ? { identityKeys: [], checkKeys: [] }
    : recipientOppositionKeys({
        role: recipientIdentityRole,
        name: recipientName,
        place: identityPlace,
        email: recipientEmail,
        officeCode: recipientOfficeCode,
        addressKind: recipientAddressKind,
      });
  const recipientIdentityKeys = recipientKeys.identityKeys;
  await assertInformationAgentContactAllowed({
    saleId: sale.id,
    email: recipientEmail,
    identityKeys: recipientIdentityKeys,
    checkKeys: recipientKeys.checkKeys,
    courtRegistryAddress: Boolean(courtFallback),
  });
  // Questions et texte du message selon le destinataire (recipient-questions.ts, recipient-templates.ts).
  // Rôle non établi (adresse saisie, contact de l'annonce) : l'organisateur de la vente décide. Une question
  // choisie par l'administrateur hors de la liste admise est refusée, jamais retirée en silence.
  const questionAudience: InformationAgentQuestionAudience = courtFallback
    ? "other"
    : informationAgentQuestionAudience({
        role: recipientIdentityRole,
        structureKind: selectedByEmail?.structureKind,
        organizerType: resolution.organizerType,
        sourceName: resolution.sourceName,
      });
  if (
    requestedQuestionKeys?.some((key) => !isInformationAgentQuestionAllowed(questionAudience, key))
  ) {
    throw new PublicApiError(INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE, 400);
  }
  const questionKeys =
    requestedQuestionKeys ??
    selectDefaultInformationAgentQuestionKeys(
      gaps.filter((gap) => isInformationAgentQuestionAllowed(questionAudience, gap.key)),
    );
  const audienceTemplate = informationAgentAudienceTemplate(questionAudience);
  if (!questionKeys.length) {
    throw new PublicApiError(
      audienceTemplate
        ? INFORMATION_AGENT_NO_GAP_FOR_LISTING_FIELDS_MESSAGE
        : INFORMATION_AGENT_NO_GAP_MESSAGE,
      400,
    );
  }
  // Refused now rather than at the preview, after the admin has read the whole draft.
  await assertNoSentCaseForRecipient(sale.id, recipientEmail);
  await assertInformationAgentRecipientCooldown({
    email: recipientEmail,
    identityKeys: recipientIdentityKeys,
    courtRegistryFallback: Boolean(courtFallback),
  });
  if (courtFallback) await assertCourtRegistryDraftAllowed(courtFallback, sale.id);
  const questionContext = informationAgentQuestionContext(inventory);
  const draft = buildInformationRequestDraft({
    sale,
    facts,
    inventory,
    signatureName: process.env.INFORMATION_AGENT_SIGNATURE_NAME,
    ...(courtFallback
      ? COURT_REGISTRY_DRAFT_OPTIONS
      : audienceTemplate
        ? {
            recipientName,
            questionKeys,
            template: audienceTemplate,
            questionLines: questionKeys.map((key) =>
              informationAgentQuestionTextFor(questionAudience, key, questionContext),
            ),
          }
        : { recipientName, questionKeys, template: emailTemplate.content }),
  });

  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .insert({
      user_id: auth.userId,
      sale_id: sale.id,
      recipient_kind:
        selectedByEmail?.recipientKind ??
        (explicitRecipientEmail ? "manual_professional" : "source_contact"),
      recipient_name: recipientName || null,
      recipient_email: recipientEmail,
      recipient_identity_keys: recipientIdentityKeys,
      share_requester_email: false,
      subject: draft.subject,
      body_text: draft.bodyText,
      question_keys: courtFallback ? [...COURT_REGISTRY_DRAFT_OPTIONS.questionKeys] : questionKeys,
      missing_information: gaps.map((gap) => gap.key),
      sale_snapshot: saleSnapshot(sale),
      privacy_version: LEGAL_DOCUMENTS.privacy.version,
      metadata: {
        draft_source: "admin_source_first_gap_analysis",
        ...(courtFallback ? courtRegistryDraftMetadata(courtFallback) : {}),
        // Lieu et rôle de l'identité (jamais l'adresse) : l'envoi recalcule les clés d'identité.
        contact_identity: {
          role: recipientIdentityRole,
          bar: identityPlace.bar,
          city: identityPlace.city,
          structure_kind: selectedByEmail?.structureKind ?? null,
          address_kind: courtFallback ? null : recipientAddressKind,
          // Office de l'adresse retenue, et office de la vente (pour une adresse saisie ensuite).
          office_code: recipientOfficeCode,
          sale_office_code: resolution.officeCode,
        },
        question_audience: questionAudience,
        candidates_skipped_for_opposition: candidatesSkippedForOpposition,
        address_search: search.snapshot,
        fact_claims_checked: claimRead.claimsBacked,
        fact_claim_count: claimRead.claims.length,
        contact_discovery: {
          method: explicitRecipientEmail
            ? "admin_override"
            : courtFallback
              ? INFORMATION_AGENT_COURT_REGISTRY_FALLBACK
              : (search.discoveryMethod ?? (selectedByEmail ? "source_data" : "manual_required")),
          selected_email: selectedByEmail?.email ?? explicitRecipientEmail ?? null,
          candidates: (courtFallback ? [courtFallback.candidate] : contactCandidates)
            .slice(0, 8)
            .map(contactCandidateSnapshot),
        },
        initiated_by_admin: auth.userId,
        ...(trigger ? { trigger: trigger.kind, autopilot_run_id: trigger.runId } : {}),
        inventory: informationAgentInventorySnapshot(inventory),
        email_content_template_id: emailTemplate.id,
        email_content_template_revision: emailTemplate.revision,
      },
    })
    .select("*")
    .single();

  if (error) throw error;
  const { error: subscribeError } = await supabaseAdmin.rpc("subscribe_information_agent_mission", {
    p_user_id: auth.userId,
    p_mission_id: data.id,
  });
  if (subscribeError) throw subscribeError;
  // L'adresse trouvée (ou celle du greffe) n'est enregistrée qu'une fois contrôlée et le brouillon créé.
  const recordedContact = foundContact ?? courtFallback?.candidate ?? null;
  if (recordedContact) {
    try {
      await persistInformationAgentContactObservations({
        saleId: sale.id,
        candidates: [recordedContact],
      });
    } catch (error) {
      // Sans ligne de registre, l'origine de l'adresse est inconnue : le brouillon est annulé.
      await cancelMission({ adminId: auth.userId, missionId: data.id }).catch(() => undefined);
      throw new PublicApiError(ADDRESS_NOT_RECORDED_MESSAGE, 503, { cause: error });
    }
  }
  // « Régénérer » replaces the previous draft for this sale and address: cancel it, so the queue
  // keeps one editable draft and the admin cannot send the outdated one by mistake. Approval makes
  // the sent mission the case initiator, so the contribution link stays valid.
  const { error: supersedeError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("user_id", auth.userId)
    .eq("sale_id", sale.id)
    .eq("recipient_email", data.recipient_email)
    .in("status", ["draft", "failed"])
    .neq("id", data.id);
  if (supersedeError) throw supersedeError;
  const subscribedMission = await loadOwnedMission(auth.userId, data.id);
  return {
    ok: true,
    mission: missionFromRow(subscribedMission),
    gaps,
    inventory: inventory.items,
    facts: await listFactsForCases(subscribedMission.case_id ? [subscribedMission.case_id] : []),
    contactCandidates: courtFallback ? [courtFallback.candidate] : contactCandidates,
  };
}

export const INFORMATION_AGENT_NO_GAP_MESSAGE =
  "Aucune lacune n'est identifiée pour cette annonce. Choisissez explicitement une question si une vérification reste nécessaire.";

export const INFORMATION_AGENT_NO_GAP_FOR_LISTING_FIELDS_MESSAGE =
  "Aucune lacune que l'agent peut demander à un notaire ou à un service de l'État (surface, pièces, occupation, visites, lieu de consultation du cahier des charges) pour cette annonce.";

function saleSnapshot(sale: AuctionSale): Json {
  return {
    id: sale.id,
    title: saleDisplayTitle(sale),
    city: sale.city,
    postal_code: sale.postal_code,
    tribunal: sale.tribunal,
    sale_date: sale.sale_date,
    starting_price_eur: sale.starting_price_eur,
    source_url: sale.source_url,
  };
}

function uniqueQuestionKeys(keys: readonly InformationAgentQuestionKey[]) {
  return [...new Set(keys)].slice(0, 8);
}
