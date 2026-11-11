import "server-only";
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
import {
  informationAgentAddressKind,
  informationAgentStructureKeys,
} from "@/lib/information-agent/contact-structure";
import {
  allowedInformationAgentQuestionKeys,
  INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE,
  informationAgentQuestionAudience,
  informationAgentQuestionTextFor,
  isInformationAgentQuestionAllowed,
} from "@/lib/information-agent/recipient-questions";
import {
  assertInformationAgentContactAllowed,
  contactCandidateSnapshot,
  discoverInformationAgentContacts,
  INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE,
  loadOpposedInformationAgentIdentityKeys,
  normalizedEmail,
  persistInformationAgentContactObservations,
  selectInformationAgentContact,
} from "@/lib/information-agent/contacts";
import { COURT_REGISTRY_FALLBACK_DISCOVERY_METHOD } from "@/lib/information-agent/court-registry-fallback";
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
import { informationAgentIdentityKeys } from "@/lib/information-agent/identity";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import { saleIdentityPlace } from "@/lib/information-agent/mission-identity";
import {
  cancelMission,
  listFactsForCases,
  loadOwnedMission,
  missionFromRow,
  requireInformationAgentAdmin,
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
  requireInformationAgentAdmin(auth);
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
    throw new Error(NO_GAP_MESSAGE);
  }
  // Opposition par identité, avant d'enregistrer ou de choisir la moindre adresse : un professionnel
  // opposé n'est plus sollicité sous une autre adresse, et son adresse n'est pas stockée.
  const identityPlace = saleIdentityPlace(sale);
  // Clés de la structure de chaque adresse (office, domaine propre) : l'opposition d'une structure écarte
  // toutes ses adresses. Seule l'adresse GÉNÉRIQUE les porte parmi ses clés d'identité : si elle s'oppose,
  // l'opposition vaut pour la structure ; l'opposition d'une personne ne vaut que pour elle.
  const structureKeysByEmail = new Map<string, string[]>();
  const discovered = discoverInformationAgentContacts(sale).map((candidate) => {
    const structureKeys = informationAgentStructureKeys({
      email: candidate.email,
      officeCode: candidate.officeCode,
    });
    structureKeysByEmail.set(candidate.email, structureKeys);
    return {
      ...candidate,
      identityKeys: [
        ...informationAgentIdentityKeys({
          role: candidate.role,
          name: candidate.name ?? (candidate.role === "lawyer" ? sale.lawyer_name : null),
          ...identityPlace,
        }),
        ...(candidate.addressKind === "generic" ? structureKeys : []),
      ],
    };
  });
  const oppositionKeysOf = (candidate: (typeof discovered)[number]) => [
    ...candidate.identityKeys,
    ...(structureKeysByEmail.get(candidate.email) ?? []),
  ];
  const opposedKeys = new Set(
    await loadOpposedInformationAgentIdentityKeys(discovered.flatMap(oppositionKeysOf)),
  );
  const listingCandidates = discovered.filter(
    (candidate) => !oppositionKeysOf(candidate).some((key) => opposedKeys.has(key)),
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
    throw new Error(
      "Le pilote automatique n'écrit ni à un greffe ni à une adresse retrouvée par recherche.",
    );
  }
  const recipientEmail =
    explicitRecipientEmail ?? selectedContact?.email ?? courtFallback?.candidate.email;
  if (!recipientEmail) {
    throw new Error(
      candidatesSkippedForOpposition > 0 && !contactCandidates.length
        ? INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE
        : missingRecipientMessage(contactCandidates.length, search.noAddressNote),
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
  const recipientStructureKeys = courtFallback
    ? []
    : informationAgentStructureKeys({
        email: recipientEmail,
        officeCode: selectedByEmail?.officeCode,
      });
  const recipientIdentityKeys = [
    ...informationAgentIdentityKeys({
      role: recipientIdentityRole,
      name: recipientName,
      ...identityPlace,
    }),
    ...(informationAgentAddressKind(recipientEmail) === "generic" ? recipientStructureKeys : []),
  ];
  await assertInformationAgentContactAllowed({
    saleId: sale.id,
    email: recipientEmail,
    identityKeys: recipientIdentityKeys,
    structureKeys: recipientStructureKeys,
    courtRegistryAddress: Boolean(courtFallback),
  });
  // Questions admises pour ce destinataire : un notaire ou un service de l'État ne reçoit que les questions
  // sur la fiche. Une question choisie par l'administrateur hors de cette liste est refusée, jamais retirée
  // en silence.
  const questionAudience = courtFallback
    ? "other"
    : informationAgentQuestionAudience({
        role: recipientIdentityRole,
        structureKind: selectedByEmail?.structureKind,
      });
  if (
    requestedQuestionKeys?.some((key) => !isInformationAgentQuestionAllowed(questionAudience, key))
  ) {
    throw new Error(INFORMATION_AGENT_QUESTION_NOT_ALLOWED_MESSAGE);
  }
  const questionKeys =
    requestedQuestionKeys ??
    selectDefaultInformationAgentQuestionKeys(
      gaps.filter((gap) => isInformationAgentQuestionAllowed(questionAudience, gap.key)),
    );
  if (!questionKeys.length) {
    throw new Error(
      questionAudience === "notary" || questionAudience === "state_service"
        ? NO_GAP_FOR_LISTING_FIELDS_MESSAGE
        : NO_GAP_MESSAGE,
    );
  }
  const listingFieldAudience =
    questionAudience === "notary" || questionAudience === "state_service";
  // Refused now rather than at the preview, after the admin has read the whole draft.
  await assertNoSentCaseForRecipient(sale.id, recipientEmail);
  await assertInformationAgentRecipientCooldown({
    email: recipientEmail,
    identityKeys: recipientIdentityKeys,
    courtRegistryFallback: Boolean(courtFallback),
  });
  if (courtFallback) await assertCourtRegistryDraftAllowed(courtFallback, sale.id);
  const draft = buildInformationRequestDraft({
    sale,
    facts,
    inventory,
    signatureName: process.env.INFORMATION_AGENT_SIGNATURE_NAME,
    ...(courtFallback
      ? COURT_REGISTRY_DRAFT_OPTIONS
      : {
          recipientName,
          questionKeys,
          template: emailTemplate.content,
          ...(listingFieldAudience
            ? {
                questionLines: allowedInformationAgentQuestionKeys(
                  questionAudience,
                  questionKeys,
                ).map((key) =>
                  informationAgentQuestionTextFor(
                    questionAudience,
                    key,
                    informationAgentQuestionContext(inventory),
                  ),
                ),
              }
            : {}),
        }),
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
          office_code: selectedByEmail?.officeCode ?? null,
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
              ? COURT_REGISTRY_FALLBACK_DISCOVERY_METHOD
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
    } catch {
      // Sans ligne de registre, l'origine de l'adresse est inconnue : le brouillon est annulé.
      await cancelMission({ adminId: auth.userId, missionId: data.id }).catch(() => undefined);
      throw new Error(ADDRESS_NOT_RECORDED_MESSAGE);
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

const NO_GAP_MESSAGE =
  "Aucune lacune n'est identifiée pour cette annonce. Choisissez explicitement une question si une vérification reste nécessaire.";

const NO_GAP_FOR_LISTING_FIELDS_MESSAGE =
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
