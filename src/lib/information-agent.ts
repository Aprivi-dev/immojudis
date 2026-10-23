import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
  renderInformationRequestEmail,
} from "../../emails/information-request";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { getPublishedInformationAgentEmailTemplate } from "@/lib/admin-information-agent-email-template";
import { adminPageQueryShape } from "@/lib/admin-page-query";
import { ADMIN_PAGE_SIZE, adminPageMeta, type AdminPageMeta } from "@/lib/admin-pagination";
import { loadAdminInformationAgentSale } from "@/lib/admin-information-agent-sale";
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import { sendResendEmail } from "@/lib/email-alerts";
import {
  getFactReliabilitiesFromClaims,
  getKeyFactReliabilities,
  type FactReliabilityMap,
} from "@/lib/fact-reliability";
import {
  buildInformationAgentInventory,
  informationAgentInventorySnapshot,
  type InformationAgentInventory,
  type InformationAgentInventoryItem,
  type InformationAgentInventorySale,
} from "@/lib/information-agent-inventory";
import { formatDate, formatStartingPrice } from "@/lib/format";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
  type InformationAgentEmailTemplateContent,
} from "@/lib/information-agent-email-template";
import {
  formatInformationAgentOriginDate,
  informationAgentControllerIdentity,
  type InformationAgentAddressOrigin,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";
import {
  informationAgentAiProvider,
  type InformationAgentAiProvider,
} from "@/lib/information-agent-ai-provider";
import { assertNoInformationAgentCommercialMention } from "@/lib/information-agent-commercial-guard";
import { buildInformationAgentOptOutUrl } from "@/lib/information-agent-opt-out";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { saleDisplayTitle } from "@/lib/sale-title";
import { resolveSiteOrigin } from "@/lib/site-url";
import type { AuctionSale } from "@/lib/types";
import { informationAgentContributionUrl } from "@/lib/information-agent-contribution";
import { informationAgentIdentityKeys } from "@/lib/information-agent/identity";
import {
  assertInformationAgentContactAllowed,
  contactCandidateSnapshot,
  INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE,
  loadOpposedInformationAgentIdentityKeys,
  recordInformationAgentAdminAddressEntry,
  discoverInformationAgentContacts,
  type InformationAgentContactCandidate,
  type InformationAgentRecipientKind,
  normalizedEmail,
  persistInformationAgentContactObservations,
  selectInformationAgentContact,
} from "@/lib/information-agent/contacts";
import {
  ADDRESS_NOT_RECORDED_MESSAGE,
  assertAgentFoundOriginIntact,
  assertInformationAgentSearchedAddressAllowed,
  isAgentFoundRecipient,
  searchInformationAgentAddressForDraft,
} from "@/lib/information-agent/address-search";
import { recordManualMissionReply } from "@/lib/information-agent/manual-reply";
import {
  assertInformationAgentSourceAllowed,
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  resolveInformationAgentAddressOrigin,
} from "@/lib/information-agent/address-origin";
import {
  missionIdentityKeys,
  missionSaleReference,
  saleIdentityPlace,
} from "@/lib/information-agent/mission-identity";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import {
  assertInformationAgentHasQuestion,
  assertInformationAgentSaleCurrent,
  assertNoSentCaseForRecipient,
  saleSourceTexts,
  shortenSubjectTitle,
  withoutProfessionSuffix,
  withSignature,
} from "@/lib/information-agent/draft-checks";

// Ré-exports : ces fonctions vivaient dans ce module (et ses tests les importent d'ici).
export {
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  resolveInformationAgentAddressOrigin,
} from "@/lib/information-agent/address-origin";
export { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
export {
  assertInformationAgentHasQuestion,
  assertInformationAgentSaleCurrent,
  INFORMATION_AGENT_NO_QUESTION_MESSAGE,
  withoutProfessionSuffix,
  withSignature,
} from "@/lib/information-agent/draft-checks";

export {
  discoverInformationAgentContacts,
  selectInformationAgentContact,
  isInformationAgentContactBlocked,
  loadInformationAgentContactRegistry,
  persistInformationAgentContactObservations,
  assertInformationAgentContactAllowed,
  assertInformationAgentIdentityAllowed,
  loadOpposedInformationAgentIdentityKeys,
  recordInformationAgentAdminAddressEntry,
  isCourtRegistryEmail,
  isInformationAgentExcludedAddress,
  informationAgentExcludedAddressReason,
} from "@/lib/information-agent/contacts";
export type {
  InformationAgentRecipientKind,
  InformationAgentContactRole,
  InformationAgentContactProvenance,
  InformationAgentContactCandidate,
  InformationAgentContactRegistryBlock,
} from "@/lib/information-agent/contacts";

import {
  detectInformationGaps,
  INFORMATION_AGENT_QUESTIONS,
  informationAgentQuestionContext,
  informationAgentQuestionText,
  selectDefaultInformationAgentQuestionKeys,
  type InformationAgentGap,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";

// Ré-exports : ces éléments vivaient dans ce module (et ses tests les importent d'ici).
export {
  detectInformationGaps,
  INFORMATION_AGENT_QUESTIONS,
  informationAgentQuestionContext,
  informationAgentQuestionText,
  selectDefaultInformationAgentQuestionKeys,
} from "@/lib/information-agent-questions";
export type {
  InformationAgentGap,
  InformationAgentQuestionContext,
  InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];
type FactRow = Database["public"]["Tables"]["information_agent_fact_candidates"]["Row"];

const QUESTION_KEYS = Object.keys(INFORMATION_AGENT_QUESTIONS) as [
  InformationAgentQuestionKey,
  ...InformationAgentQuestionKey[],
];

export const informationAgentCreateSchema = z.object({
  saleId: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  recipientName: z.string().trim().max(180).optional(),
  questionKeys: z.array(z.enum(QUESTION_KEYS)).min(1).max(8).optional(),
});

export const informationAgentListQuerySchema = z.object({
  saleId: z.string().uuid().optional(),
  ...adminPageQueryShape,
});

const editableMessageFields = {
  recipientEmail: z.string().trim().email().max(320),
  recipientName: z.string().trim().max(180).nullable().optional(),
  subject: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), "Objet invalide."),
  bodyText: z.string().trim().min(20).max(8000),
  /**
   * Page publique où figure l'adresse, obligatoire quand elle ne provient pas de l'annonce de la
   * vente (adresse saisie par un administrateur) : elle est citée au destinataire (art. 14 RGPD).
   */
  recipientOriginUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((value) => /^https?:\/\/\S+$/i.test(value), "Lien de la page publique invalide.")
    .nullable()
    .optional(),
};

/** Aperçu exact de l'e-mail, préalable obligatoire à tout envoi. */
export const informationAgentPreviewSchema = z.object({
  missionId: z.string().uuid(),
  ...editableMessageFields,
});
export type InformationAgentPreviewInput = z.output<typeof informationAgentPreviewSchema>;

// The admin workflow deliberately does not expose the former end-user consent
// flag. Admins are the sole initiators of these requests and the requester
// email is never shared with the professional contact.
export const informationAgentAdminActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve_and_send"),
    missionId: z.string().uuid(),
    approvalConfirmed: z.literal(true),
    /** Empreinte rendue par l'aperçu de ce contenu exact : sans aperçu, aucun envoi. */
    previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Aperçu requis avant l'envoi."),
    ...editableMessageFields,
  }),
  z.object({
    action: z.literal("cancel"),
    missionId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("record_reply"),
    missionId: z.string().uuid(),
    bodyText: z.string().trim().min(1).max(16000),
    subject: z.string().trim().min(3).max(200).optional(),
  }),
]);

export type InformationAgentCreateInput = z.input<typeof informationAgentCreateSchema>;
export type InformationAgentAdminActionPayload = z.output<typeof informationAgentAdminActionSchema>;

export type InformationAgentMission = {
  id: string;
  caseId: string | null;
  saleId: string | null;
  status: MissionRow["status"];
  recipientKind: InformationAgentRecipientKind;
  recipientName: string | null;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  questionKeys: InformationAgentQuestionKey[];
  missingInformation: string[];
  /** Inventaire enregistré avec le brouillon (absent des missions antérieures). */
  inventory: InformationAgentInventoryItem[];
  failureReason: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Titre de la vente, renseigné par la liste admin seulement (jamais par l'e-mail ni le dépôt). */
  saleTitle?: string | null;
};

export type InformationAgentFact = {
  id: string;
  caseId: string;
  factKey: FactRow["fact_key"];
  displayValue: string;
  confidence: number;
  status: FactRow["status"];
  evidenceExcerpt: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type InformationAgentAdminResponse = {
  ok: true;
  mission: InformationAgentMission;
  gaps: InformationAgentGap[];
  /** Ce que la fiche contient déjà et ce qui manque, au moment du brouillon. */
  inventory: InformationAgentInventoryItem[];
  facts: InformationAgentFact[];
  contactCandidates?: InformationAgentContactCandidate[];
};

export type InformationAgentAdminListResponse = {
  ok: true;
  missions: InformationAgentMission[];
  facts: InformationAgentFact[];
};

/** Liste paginée des missions (50 par page) : offset / limit demandés, total toutes pages. */
export type InformationAgentAdminMissionPage = InformationAgentAdminListResponse & AdminPageMeta;

export function buildInformationRequestDraft({
  sale,
  recipientName,
  questionKeys,
  facts,
  inventory,
  template = DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  signatureName = null,
}: {
  sale: InformationAgentInventorySale;
  recipientName?: string | null;
  questionKeys: readonly InformationAgentQuestionKey[];
  facts?: FactReliabilityMap;
  inventory?: InformationAgentInventory;
  template?: InformationAgentEmailTemplateContent;
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
      questions: questionKeys
        .map((key) => `- ${informationAgentQuestionText(key, questionContext)}`)
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
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof informationAgentCreateSchema>;
}): Promise<InformationAgentAdminResponse> {
  requireInformationAgentAdmin(auth);

  const [sale, emailTemplate] = await Promise.all([
    loadAdminInformationAgentSale({ auth, saleId: input.saleId }),
    getPublishedInformationAgentEmailTemplate(),
  ]);
  const claimRead = await readSaleFactClaims(sale.id);
  const facts = getFactReliabilitiesFromClaims(sale, claimRead.claims);
  const inventory = buildInformationAgentInventory(sale, facts);
  const gaps = detectInformationGaps(sale, facts, inventory);
  const defaultQuestions = selectDefaultInformationAgentQuestionKeys(gaps);
  const questionKeys = uniqueQuestionKeys(input.questionKeys ?? defaultQuestions);
  if (!questionKeys.length) {
    throw new Error(
      "Aucune lacune n'est identifiée pour cette annonce. Choisissez explicitement une question si une vérification reste nécessaire.",
    );
  }
  // Opposition par identité, avant d'enregistrer ou de choisir la moindre adresse : un professionnel
  // opposé n'est plus sollicité sous une autre adresse, et son adresse n'est pas stockée.
  const identityPlace = saleIdentityPlace(sale);
  const discovered = discoverInformationAgentContacts(sale).map((candidate) => ({
    ...candidate,
    identityKeys: informationAgentIdentityKeys({
      role: candidate.role,
      name: candidate.name ?? (candidate.role === "lawyer" ? sale.lawyer_name : null),
      ...identityPlace,
    }),
  }));
  const opposedKeys = new Set(
    await loadOpposedInformationAgentIdentityKeys(discovered.flatMap((item) => item.identityKeys)),
  );
  const listingCandidates = discovered.filter(
    (candidate) => !candidate.identityKeys.some((key) => opposedKeys.has(key)),
  );
  const candidatesSkippedForOpposition = discovered.length - listingCandidates.length;
  const explicitRecipientEmail = normalizedEmail(input.recipientEmail);

  // Recherche autonome (niveau 1), sans adresse dans l'annonce ni saisie : elle ne fait que préparer.
  const search = await searchInformationAgentAddressForDraft({
    sale,
    identityPlace,
    siteOrigin: informationAgentAppOrigin(),
    skip: Boolean(explicitRecipientEmail) || discovered.length > 0,
  });
  const foundContact = search.candidate;
  const contactCandidates = foundContact ? [foundContact] : listingCandidates;
  await persistInformationAgentContactObservations({
    saleId: sale.id,
    candidates: foundContact ? [] : contactCandidates,
  });
  const selectedContact = foundContact ?? selectInformationAgentContact(contactCandidates);
  const recipientEmail = explicitRecipientEmail ?? selectedContact?.email;
  if (!recipientEmail) {
    throw new Error(
      candidatesSkippedForOpposition > 0 && !contactCandidates.length
        ? INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE
        : contactCandidates.length > 1
          ? "Requête invalide : plusieurs contacts sont possibles. Choisissez explicitement l'adresse email du professionnel à contacter."
          : `Requête invalide : renseignez l'adresse email du professionnel à contacter.${search.noAddressNote}`,
    );
  }
  const selectedByEmail = contactCandidates.find((candidate) => candidate.email === recipientEmail);
  // A manual address or another source contact must not inherit the lawyer's
  // name: it can belong to a different professional entirely.
  const recipientName =
    input.recipientName ?? withoutProfessionSuffix(selectedByEmail?.name ?? "") ?? null;
  const recipientIdentityRole = selectedByEmail?.role ?? null;
  const recipientIdentityKeys = informationAgentIdentityKeys({
    role: recipientIdentityRole,
    name: recipientName,
    ...identityPlace,
  });
  await assertInformationAgentContactAllowed({
    saleId: sale.id,
    email: recipientEmail,
    identityKeys: recipientIdentityKeys,
  });
  // Refused now rather than at the preview, after the admin has read the whole draft.
  await assertNoSentCaseForRecipient(sale.id, recipientEmail);
  await assertInformationAgentRecipientCooldown({
    email: recipientEmail,
    identityKeys: recipientIdentityKeys,
  });
  const draft = buildInformationRequestDraft({
    sale,
    recipientName,
    questionKeys,
    facts,
    inventory,
    template: emailTemplate.content,
    signatureName: process.env.INFORMATION_AGENT_SIGNATURE_NAME,
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
      question_keys: questionKeys,
      missing_information: gaps.map((gap) => gap.key),
      sale_snapshot: saleSnapshot(sale),
      privacy_version: LEGAL_DOCUMENTS.privacy.version,
      metadata: {
        draft_source: "admin_source_first_gap_analysis",
        // Lieu et rôle de l'identité (jamais l'adresse) : l'envoi recalcule les clés d'identité.
        contact_identity: {
          role: recipientIdentityRole,
          bar: identityPlace.bar,
          city: identityPlace.city,
        },
        candidates_skipped_for_opposition: candidatesSkippedForOpposition,
        address_search: search.snapshot,
        fact_claims_checked: claimRead.claimsBacked,
        fact_claim_count: claimRead.claims.length,
        contact_discovery: {
          method: explicitRecipientEmail
            ? "admin_override"
            : (search.discoveryMethod ?? (selectedByEmail ? "source_data" : "manual_required")),
          selected_email: selectedByEmail?.email ?? explicitRecipientEmail ?? null,
          candidates: contactCandidates.slice(0, 8).map(contactCandidateSnapshot),
        },
        initiated_by_admin: auth.userId,
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
  // L'adresse trouvée n'est enregistrée qu'une fois contrôlée et le brouillon créé.
  if (foundContact) {
    try {
      await persistInformationAgentContactObservations({
        saleId: sale.id,
        candidates: [foundContact],
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
    contactCandidates,
  };
}

export async function listAdminInformationAgentMissions({
  auth,
  saleId,
  offset = 0,
  limit = ADMIN_PAGE_SIZE,
}: {
  auth: SupabaseAuthContext;
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<InformationAgentAdminMissionPage> {
  requireInformationAgentAdmin(auth);
  let query = supabaseAdmin
    .from("information_agent_missions")
    .select("*", { count: "exact" })
    .eq("user_id", auth.userId)
    // L'id départage les missions créées dans la même milliseconde : pages stables.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const saleTitles = await loadSaleTitles(
    rows.flatMap((mission) => (mission.sale_id ? [mission.sale_id] : [])),
  );
  return {
    ok: true,
    missions: rows.map((row) => ({
      ...missionFromRow(row),
      saleTitle: row.sale_id ? (saleTitles.get(row.sale_id) ?? null) : null,
    })),
    facts: await listFactsForCases(
      rows.flatMap((mission) => (mission.case_id ? [mission.case_id] : [])),
    ),
    ...adminPageMeta({ offset, limit, total: count ?? offset + rows.length }),
  };
}

/**
 * Titres des ventes de la page de missions, pour que l'administrateur reconnaisse la vente sans
 * ouvrir chaque ligne. Réservé à la liste admin ; une lecture en échec laisse simplement les lignes
 * sans titre (jamais un échec de la liste).
 */
async function loadSaleTitles(saleIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const uniqueIds = [...new Set(saleIds)];
  if (!uniqueIds.length) return titles;
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select("id,title")
    .in("id", uniqueIds);
  if (error) {
    console.warn("Titres des ventes de l'agent illisibles", { code: error.code ?? null });
    return titles;
  }
  for (const row of data ?? []) {
    if (typeof row.title === "string" && row.title.trim()) titles.set(row.id, row.title.trim());
  }
  return titles;
}

export async function runAdminInformationAgentAction({
  auth,
  input,
  fetchImpl = fetch,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentAdminActionPayload;
  fetchImpl?: typeof fetch;
}): Promise<InformationAgentAdminListResponse> {
  requireInformationAgentAdmin(auth);

  if (input.action === "approve_and_send") {
    await approveAndSendMission({ adminId: auth.userId, input, fetchImpl });
  } else if (input.action === "record_reply") {
    const replyMission = await loadOwnedMission(auth.userId, input.missionId);
    await recordManualMissionReply({ mission: replyMission, input });
  } else {
    await cancelMission({ adminId: auth.userId, missionId: input.missionId });
  }

  const mission = await loadOwnedMission(auth.userId, input.missionId);
  return {
    ok: true,
    missions: [missionFromRow(mission)],
    facts: await listFactsForCases(mission.case_id ? [mission.case_id] : []),
  };
}

async function approveAndSendMission({
  adminId,
  input,
  fetchImpl,
}: {
  adminId: string;
  input: Extract<InformationAgentAdminActionPayload, { action: "approve_and_send" }>;
  fetchImpl: typeof fetch;
}) {
  const mission = await loadOwnedMission(adminId, input.missionId);
  if (mission.status !== "draft" && mission.status !== "failed") {
    throw new Error("Requête invalide : cette enquête ne peut plus être modifiée.");
  }
  // Envoi strictement manuel : l'administrateur a affiché l'aperçu de ce contenu exact.
  assertInformationAgentPreviewFingerprint({ adminId, input });
  // Aucune mention commerciale : le message reste purement informatif.
  assertNoInformationAgentCommercialMention(`${input.subject}\n${input.bodyText}`, {
    ignore: saleSourceTexts(mission),
  });
  assertInformationAgentHasQuestion(input.bodyText);
  await assertInformationAgentSaleCurrent(mission);
  // Opposition par adresse et par identité (le nom corrigé à l'aperçu compte), avant l'envoi.
  const identityKeys = missionIdentityKeys(mission, input.recipientName);
  await assertInformationAgentContactAllowed({
    saleId: mission.sale_id,
    email: input.recipientEmail,
    identityKeys,
  });
  // Adresse retrouvée par l'agent : sa seule origine est la ligne de registre de l'agent.
  const agentFound = isAgentFoundRecipient(mission, input.recipientEmail);
  const addressOrigin = await resolveInformationAgentAddressOrigin({
    email: input.recipientEmail,
    saleId: mission.sale_id,
    manualOriginUrl: agentFound ? null : (input.recipientOriginUrl ?? null),
    fallbackObservedAt: mission.created_at,
  });
  if (!addressOrigin.known) throw new Error(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
  assertAgentFoundOriginIntact(agentFound, addressOrigin);
  assertInformationAgentSourceAllowed(addressOrigin);
  assertInformationAgentSearchedAddressAllowed(addressOrigin.origin);
  assertInformationAgentOutboundEnabled();
  assertInformationAgentCanaryRecipient(input.recipientEmail);
  // Validate delivery prerequisites before approval reserves the case for sending.
  // Otherwise a configuration error can leave an approved case with no delivery attempt.
  const config = resolveInformationAgentEmailConfig();

  // GDPR art. 14 prerequisites: a named controller, and at most one email per recipient per 30 days.
  assertInformationAgentControllerIdentity();
  await assertInformationAgentRecipientCooldown({
    email: input.recipientEmail,
    missionId: mission.id,
    identityKeys,
  });

  // An admin may replace a source-derived address while approving the draft.
  // Preserve the provenance only when the normalized address is unchanged;
  // otherwise the canonical case must record an explicit manual recipient.
  const recipientKind =
    normalizedEmail(input.recipientEmail) === normalizedEmail(mission.recipient_email)
      ? mission.recipient_kind
      : "manual_professional";

  // Adresse saisie par un administrateur : source typée, date de relevé et auteur au registre.
  if (addressOrigin.kind === "admin_entry" && mission.sale_id) {
    await recordInformationAgentAdminAddressEntry({
      saleId: mission.sale_id,
      email: input.recipientEmail,
      name: input.recipientName || mission.recipient_name,
      url: addressOrigin.origin.url,
      observedAt: mission.created_at,
      adminId,
      identityKeys,
    });
  }

  const { data: edited, error: editError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({
      recipient_email: input.recipientEmail,
      recipient_identity_keys: identityKeys,
      recipient_kind: recipientKind,
      recipient_name: input.recipientName || null,
      reply_to_email: null,
      share_requester_email: false,
      subject: input.subject,
      body_text: input.bodyText,
      failure_reason: null,
      metadata: {
        ...asObject(mission.metadata),
        recipient_origin_url: input.recipientOriginUrl ?? null,
        preview_fingerprint: input.previewFingerprint,
      },
    })
    .eq("id", mission.id)
    .eq("user_id", mission.user_id)
    .in("status", ["draft", "failed"])
    .select("*")
    .single();
  if (editError) throw editError;

  const { error: subscribeError } = await supabaseAdmin.rpc("subscribe_information_agent_mission", {
    p_user_id: mission.user_id,
    p_mission_id: mission.id,
  });
  if (subscribeError) throw subscribeError;
  const subscribedMission = await loadOwnedMission(adminId, mission.id);
  const contributionUrl = informationAgentContributionUrl(subscribedMission);
  const messageHash = approvalFingerprint(subscribedMission);
  const approval = await approveInformationAgentMissionForAdmin(subscribedMission, messageHash);
  if (!approval) throw new Error("Approbation de l'enquête impossible.");
  if (!approval.should_send) {
    // The shared case already left the draft stage (another mission sent it): saying « updated »
    // would let the admin believe this email went out.
    throw new Error(
      "Aucun email n’est parti : cette demande est rattachée à un dossier déjà envoyé à cette adresse pour cette vente.",
    );
  }

  const replyTo = `enquete+${approval.inbound_token}@${config.inboundDomain}`;
  const sendingAt = new Date().toISOString();
  // Set once Resend has accepted the message: from then on the mission is never downgraded.
  let delivered: { id: string | null; sentAt: string } | null = null;

  try {
    await assertInformationAgentContactAllowed({
      saleId: subscribedMission.sale_id,
      email: edited.recipient_email,
      identityKeys: edited.recipient_identity_keys,
    });
    // Approval is already recorded: if a concurrent approval for the same recipient is older,
    // this one stands down, so only the earliest request is ever sent within the 30 days.
    const approvedMission = await loadOwnedMission(adminId, mission.id);
    await assertInformationAgentRecipientCooldown({
      email: edited.recipient_email,
      missionId: mission.id,
      identityKeys: edited.recipient_identity_keys,
      approvedAt: approvedMission.approved_at,
    });
    const legalFooter = buildInformationAgentLegalFooter({
      appUrl: config.appUrl,
      email: edited.recipient_email,
      addressOrigin: addressOrigin.origin,
      saleReference: missionSaleReference(subscribedMission),
    });
    const renderedEmail = await renderInformationRequestEmail({
      subject: edited.subject,
      bodyText: edited.body_text,
      replyTo,
      caseReference: informationAgentCaseReference(approval.case_id),
      appUrl: config.appUrl,
      contributionUrl,
      legalFooter,
    });
    assertNoInformationAgentCommercialMention(`${renderedEmail.html}\n${renderedEmail.text}`, {
      appOrigin: config.appUrl,
      allowedUrls: [legalFooter.addressOriginUrl],
      // La référence de la vente vient de l'annonce : elle ne peut pas faire échouer l'envoi.
      ignore: [legalFooter.saleReference, ...saleSourceTexts(mission)],
    });
    await assertInformationAgentContactAllowed({
      saleId: subscribedMission.sale_id,
      email: edited.recipient_email,
      identityKeys: edited.recipient_identity_keys,
    });
    assertInformationAgentCanaryRecipient(edited.recipient_email);
    const delivery = await sendResendEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-information-agent-case-${approval.case_id}`,
      fetchImpl,
      message: {
        from: config.from,
        to: edited.recipient_email,
        replyTo,
        subject: edited.subject,
        text: renderedEmail.text,
        html: renderedEmail.html,
        // RFC 8058 : l'opposition en un clic est proposée par la messagerie du destinataire.
        unsubscribeUrl: legalFooter.optOutUrl,
        oneClickUnsubscribe: true,
      },
    });
    const sentAt = new Date().toISOString();
    delivered = { id: delivery.id, sentAt };
    const missionMetadata = asObject(edited.metadata);
    const { error: messageError } = await supabaseAdmin.from("information_agent_messages").insert({
      mission_id: mission.id,
      case_id: approval.case_id,
      user_id: mission.user_id,
      direction: "outbound",
      message_kind: "initial",
      delivery_status: "sent",
      from_email: config.from,
      to_email: edited.recipient_email,
      subject: edited.subject,
      body_text: edited.body_text,
      provider_message_id: delivery.id,
      sent_at: sentAt,
      metadata: {
        approval_sha256: messageHash,
        preview_fingerprint: input.previewFingerprint,
        approved_by_admin: adminId,
        address_origin_url: legalFooter.addressOriginUrl ?? null,
        address_origin_text: legalFooter.addressOrigin,
        email_template_version: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
        email_content_template_id: missionMetadata.email_content_template_id ?? null,
        email_content_template_revision: missionMetadata.email_content_template_revision ?? null,
      },
    });
    if (messageError) throw messageError;
    await updateMissionOrThrow(mission.id, mission.user_id, {
      status: "sent",
      reply_to_email: replyTo,
      sent_at: sentAt,
      provider_message_id: delivery.id,
      failure_reason: null,
    });
    await updateCaseOrThrow(approval.case_id, {
      status: "sent",
      sent_at: sentAt,
      provider_message_id: delivery.id,
      failure_reason: null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "Envoi impossible.";
    if (delivered) {
      // The email is out. Marking the mission failed would free the 30-day cooldown and invite a
      // manual retry that sends a second email: keep it sent and say what is incomplete.
      const note = `Message accepté par Resend (${delivered.id ?? "identifiant non communiqué"}), enregistrement incomplet : ${detail}`;
      await Promise.allSettled([
        updateMissionOrThrow(mission.id, mission.user_id, {
          status: "sent",
          reply_to_email: replyTo,
          sent_at: delivered.sentAt,
          provider_message_id: delivered.id,
          failure_reason: note,
        }),
        updateCaseOrThrow(approval.case_id, {
          status: "sent",
          sent_at: delivered.sentAt,
          provider_message_id: delivered.id,
          failure_reason: note,
        }),
      ]);
      throw new Error(`${note}. Ne renvoyez pas ce message.`, { cause: error });
    }
    await updateMissionOrThrow(mission.id, mission.user_id, {
      status: "failed",
      failure_reason: detail,
      metadata: { ...asObject(edited.metadata), last_send_attempt_at: sendingAt },
    });
    await updateCaseOrThrow(approval.case_id, {
      status: "failed",
      failure_reason: detail,
    });
    throw error;
  }
}

/** Refuses to send while the data controller identity (art. 14 GDPR) is not configured. */
export function assertInformationAgentControllerIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!informationAgentControllerIdentity(env)) {
    throw new Error(
      "Identité du responsable de traitement non configurée : envoi impossible (NEXT_PUBLIC_LEGAL_ENTITY_NAME, NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS et NEXT_PUBLIC_LEGAL_CONTACT_EMAIL).",
    );
  }
}

function informationAgentPortalSecret(env: Readonly<Record<string, string | undefined>>) {
  const secret = env.INFORMATION_AGENT_PORTAL_SECRET?.trim();
  return secret && Buffer.byteLength(secret, "utf8") >= 32 ? secret : null;
}

function buildInformationAgentLegalFooter({
  appUrl,
  email,
  addressOrigin,
  saleReference = null,
  env = process.env,
}: {
  appUrl: string;
  email: string;
  addressOrigin: InformationAgentAddressOrigin;
  saleReference?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
}): InformationAgentLegalFooter {
  const controller = informationAgentControllerIdentity(env);
  if (!controller) assertInformationAgentControllerIdentity(env);
  const secret = informationAgentPortalSecret(env);
  if (!secret) throw new Error("Secret du lien d'opposition non configuré : envoi impossible.");
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  return {
    controllerName: controller!.name,
    controllerAddress: controller!.address,
    contactEmail: controller!.contactEmail,
    saleReference,
    addressOrigin: addressOrigin.text,
    addressOriginUrl: addressOrigin.url,
    automatedSearch: addressOrigin.automated,
    automatedSearchSource: addressOrigin.searchSource,
    // Lève une erreur si la configuration désigne un prestataire d'IA non nommé dans le pied.
    aiProvider: informationAgentAiProvider(env),
    privacyUrl: new URL("/privacy", appUrl).toString(),
    optOutUrl: buildInformationAgentOptOutUrl({ appUrl, email: normalized, secret }),
  };
}

const PREVIEW_FINGERPRINT_CONTEXT = "immojudis:information-agent:preview:v1";

/**
 * Empreinte HMAC du contenu exact affiché dans l'aperçu (destinataire, objet, texte, origine,
 * version du gabarit) et de l'administrateur qui l'a vu. Seul le serveur peut la produire : un
 * envoi sans aperçu préalable, ou après une modification non prévisualisée, est refusé.
 */
export function informationAgentPreviewFingerprint(
  {
    adminId,
    missionId,
    recipientEmail,
    recipientName,
    subject,
    bodyText,
    recipientOriginUrl,
  }: {
    adminId: string;
    missionId: string;
    recipientEmail: string;
    recipientName?: string | null;
    subject: string;
    bodyText: string;
    recipientOriginUrl?: string | null;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const secret = informationAgentPortalSecret(env);
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(
      `${PREVIEW_FINGERPRINT_CONTEXT}:${JSON.stringify({
        adminId,
        missionId,
        recipientEmail: normalizedEmail(recipientEmail) ?? recipientEmail.trim().toLowerCase(),
        recipientName: recipientName?.trim() || null,
        subject: subject.trim(),
        bodyText: bodyText.trim(),
        recipientOriginUrl: recipientOriginUrl?.trim() || null,
        emailTemplateVersion: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
      })}`,
    )
    .digest("hex");
}

function assertInformationAgentPreviewFingerprint({
  adminId,
  input,
}: {
  adminId: string;
  input: Extract<InformationAgentAdminActionPayload, { action: "approve_and_send" }>;
}): void {
  const expected = informationAgentPreviewFingerprint({ adminId, ...input });
  if (!expected) {
    throw new Error("Secret du lien d'opposition non configuré : envoi impossible.");
  }
  const received = Buffer.from(input.previewFingerprint ?? "", "hex");
  const reference = Buffer.from(expected, "hex");
  if (received.length !== reference.length || !timingSafeEqual(received, reference)) {
    throw new Error(
      "Le message a changé depuis l’aperçu, ou aucun aperçu n’a été affiché : affichez l’aperçu de la version finale avant d’envoyer.",
    );
  }
}

export type InformationAgentPreviewResponse = {
  ok: true;
  preview: {
    from: string | null;
    to: string;
    replyTo: string;
    subject: string;
    html: string;
    text: string;
  };
  /** Motifs qui empêcheront l'envoi (opposition, délai de 30 jours, configuration…). */
  blockers: string[];
  addressOrigin: { text: string; url: string | null; automated: boolean; known: boolean };
  /** À renvoyer avec « Valider et envoyer » ; null si l'envoi est impossible. */
  fingerprint: string | null;
};

/**
 * Aperçu exact de l'e-mail tel qu'il partira, sans rien enregistrer ni envoyer. Les seuls éléments
 * illustratifs sont le jeton de l'adresse de réponse et le lien privé de dépôt, attribués à l'envoi.
 */
export async function previewAdminInformationAgentMission({
  auth,
  input,
  env = process.env,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentPreviewInput;
  env?: NodeJS.ProcessEnv;
}): Promise<InformationAgentPreviewResponse> {
  requireInformationAgentAdmin(auth);
  const mission = await loadOwnedMission(auth.userId, input.missionId);
  const recipient = normalizedEmail(input.recipientEmail);
  if (!recipient) throw new Error("Requête invalide : adresse email du destinataire invalide.");
  const blockers: string[] = [];
  const collect = async (check: () => unknown) => {
    try {
      await check();
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "Contrôle impossible.");
    }
  };

  if (mission.status !== "draft" && mission.status !== "failed") {
    blockers.push("Cette mission n’est plus un brouillon : elle ne peut pas être envoyée.");
  }
  await collect(() =>
    assertInformationAgentContactAllowed({
      saleId: mission.sale_id,
      email: recipient,
      identityKeys: missionIdentityKeys(mission, input.recipientName),
    }),
  );
  await collect(() =>
    assertNoInformationAgentCommercialMention(`${input.subject}\n${input.bodyText}`, {
      ignore: saleSourceTexts(mission),
    }),
  );
  await collect(() => assertInformationAgentHasQuestion(input.bodyText));
  await collect(() => assertInformationAgentSaleCurrent(mission));
  await collect(() =>
    assertInformationAgentRecipientCooldown({
      email: recipient,
      missionId: mission.id,
      identityKeys: missionIdentityKeys(mission, input.recipientName),
    }),
  );
  const agentFound = isAgentFoundRecipient(mission, recipient);
  const addressOrigin = await resolveInformationAgentAddressOrigin({
    email: recipient,
    saleId: mission.sale_id,
    manualOriginUrl: agentFound ? null : (input.recipientOriginUrl ?? null),
    fallbackObservedAt: mission.created_at,
  });
  if (!addressOrigin.known) blockers.push(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
  await collect(() => assertAgentFoundOriginIntact(agentFound, addressOrigin));
  await collect(() => assertInformationAgentSourceAllowed(addressOrigin));
  await collect(() => assertInformationAgentSearchedAddressAllowed(addressOrigin.origin, env));
  await collect(() => assertInformationAgentOutboundEnabled(env));
  await collect(() => assertInformationAgentCanaryRecipient(recipient, env));
  await collect(() => resolveInformationAgentEmailConfig(env));
  await collect(() => assertInformationAgentControllerIdentity(env));

  const appUrl = informationAgentAppOrigin(env);
  const controller = informationAgentControllerIdentity(env);
  const secret = informationAgentPortalSecret(env);
  if (!secret) blockers.push("Secret du lien d'opposition non configuré : envoi impossible.");
  const legalFooter: InformationAgentLegalFooter = {
    controllerName: controller?.name ?? "[Responsable de traitement à configurer]",
    controllerAddress: controller?.address ?? "[Adresse à configurer]",
    contactEmail: controller?.contactEmail ?? "[Contact à configurer]",
    saleReference: missionSaleReference(mission),
    addressOrigin: addressOrigin.origin.text,
    addressOriginUrl: addressOrigin.origin.url,
    automatedSearch: addressOrigin.origin.automated,
    automatedSearchSource: addressOrigin.origin.searchSource,
    aiProvider: previewAiProvider(env, blockers),
    privacyUrl: new URL("/privacy", appUrl).toString(),
    optOutUrl: secret
      ? buildInformationAgentOptOutUrl({ appUrl, email: recipient, secret })
      : new URL("/api/information-agent/opt-out", appUrl).toString(),
  };
  const inboundDomain =
    env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase() || "reponses.immojudis.com";
  const replyTo = `enquete+jeton-attribue-a-l-envoi@${inboundDomain}`;
  const rendered = await renderInformationRequestEmail({
    subject: input.subject,
    bodyText: input.bodyText,
    replyTo,
    caseReference: mission.case_id ? informationAgentCaseReference(mission.case_id) : "IJ-APERCU",
    appUrl,
    contributionUrl: new URL("/contribuer/lien-prive-attribue-a-l-envoi", appUrl).toString(),
    legalFooter,
  });
  await collect(() =>
    assertNoInformationAgentCommercialMention(`${rendered.html}\n${rendered.text}`, {
      appOrigin: appUrl,
      allowedUrls: [addressOrigin.origin.url],
      ignore: [legalFooter.saleReference, ...saleSourceTexts(mission)],
    }),
  );
  return {
    ok: true,
    preview: {
      from: env.INFORMATION_AGENT_EMAIL_FROM?.trim() || null,
      to: input.recipientName?.trim() ? `${input.recipientName.trim()} <${recipient}>` : recipient,
      replyTo,
      subject: input.subject,
      html: rendered.html,
      text: rendered.text,
    },
    blockers: [...new Set(blockers)],
    addressOrigin: { ...addressOrigin.origin, known: addressOrigin.known },
    fingerprint: informationAgentPreviewFingerprint({ adminId: auth.userId, ...input }, env),
  };
}

/** Prestataire d'IA du pied ; une configuration inconnue devient un motif de blocage de l'aperçu. */
function previewAiProvider(
  env: Readonly<Record<string, string | undefined>>,
  blockers: string[],
): InformationAgentAiProvider {
  try {
    return informationAgentAiProvider(env);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "Prestataire d’IA non identifié.");
    return informationAgentAiProvider({});
  }
}

export function assertInformationAgentOutboundEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.INFORMATION_AGENT_OUTBOUND_ENABLED !== "true") {
    throw new Error("Envoi de l’agent désactivé pendant la phase de validation.");
  }
}

/** Keep the first provider canary restricted to Resend's own delivery test address. */
export function assertInformationAgentCanaryRecipient(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.INFORMATION_AGENT_OUTBOUND_CANARY_ONLY === "false") return;
  if (email.trim().toLowerCase() !== "delivered@resend.dev") {
    throw new Error("Envoi limité à l'adresse de test du fournisseur pendant l'essai canari.");
  }
}

async function cancelMission({ adminId, missionId }: { adminId: string; missionId: string }) {
  const mission = await loadOwnedMission(adminId, missionId);
  if (!(["draft", "failed"] as MissionRow["status"][]).includes(mission.status)) {
    throw new Error("Requête invalide : un message déjà envoyé ne peut pas être annulé.");
  }
  await updateMissionOrThrow(mission.id, mission.user_id, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
}

function requireInformationAgentAdmin(auth: SupabaseAuthContext): void {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
}

async function loadOwnedMission(userId: string, missionId: string): Promise<MissionRow> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("id", missionId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Requête invalide : enquête introuvable.");
  return data;
}

type InformationAgentApproval = {
  case_id: string;
  should_send: boolean;
  inbound_token: string;
};

/**
 * Approves an admin mission without calling the user quota RPC. The existing
 * case/subscriber model is retained so inbound Resend replies continue to be
 * routed and reviewed exactly as before.
 */
async function approveInformationAgentMissionForAdmin(
  mission: MissionRow,
  messageHash: string,
): Promise<InformationAgentApproval> {
  const { data, error } = await supabaseAdmin.rpc("approve_information_agent_mission_admin", {
    p_admin_id: mission.user_id,
    p_mission_id: mission.id,
    p_message_sha256: messageHash,
  });
  if (error) throw new Error(error.message || "Approbation admin impossible.");
  const approval = data?.[0];
  if (!approval) throw new Error("Approbation admin impossible.");
  return approval;
}

async function updateMissionOrThrow(
  missionId: string,
  userId: string,
  values: Database["public"]["Tables"]["information_agent_missions"]["Update"],
) {
  const { error } = await supabaseAdmin
    .from("information_agent_missions")
    .update(values)
    .eq("id", missionId)
    .eq("user_id", userId);
  if (error) throw error;
}

function missionFromRow(row: MissionRow): InformationAgentMission {
  return {
    id: row.id,
    caseId: row.case_id,
    saleId: row.sale_id,
    status: row.status,
    // Colonne text protégée par une contrainte CHECK : le type généré est string.
    recipientKind: row.recipient_kind as InformationAgentRecipientKind,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    bodyText: row.body_text,
    questionKeys: row.question_keys.filter(isQuestionKey),
    missingInformation: row.missing_information,
    inventory: inventoryFromMetadata(row.metadata),
    failureReason: row.failure_reason,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INVENTORY_STATUSES = new Set(["present", "to_confirm", "missing", "not_applicable"]);

function inventoryFromMetadata(metadata: Json): InformationAgentInventoryItem[] {
  const value = asObject(metadata).inventory;
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const entry = asObject(raw ?? null);
    const { key, label, status, detail, origin } = entry;
    if (
      typeof key !== "string" ||
      typeof label !== "string" ||
      typeof status !== "string" ||
      !INVENTORY_STATUSES.has(status) ||
      typeof detail !== "string"
    ) {
      return [];
    }
    return [
      {
        key: key as InformationAgentInventoryItem["key"],
        label,
        status: status as InformationAgentInventoryItem["status"],
        detail,
        origin: typeof origin === "string" ? origin : null,
      },
    ];
  });
}

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

function approvalFingerprint(mission: MissionRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recipientEmail: mission.recipient_email,
        replyToEmail: mission.reply_to_email,
        subject: mission.subject,
        bodyText: mission.body_text,
        emailTemplateVersion: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
      }),
    )
    .digest("hex");
}

/**
 * Configuration d'envoi de l'agent. L'expéditeur est celui de l'agent, `INFORMATION_AGENT_EMAIL_FROM`,
 * et rien d'autre : le repli sur `ALERT_EMAIL_FROM` envoyait les emails à des tiers depuis l'adresse
 * des alertes aux comptes, donc leur réputation d'expéditeur était commune. Sans expéditeur, l'envoi
 * est bloqué (et l'aperçu le dit).
 */
export function resolveInformationAgentEmailConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.INFORMATION_AGENT_EMAIL_FROM?.trim();
  const inboundDomain = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!apiKey || !from || !inboundDomain) {
    throw new Error("Configuration d'envoi et de réception de l'agent incomplète.");
  }
  return { apiKey, from, inboundDomain, appUrl: informationAgentAppOrigin(env) };
}

/**
 * Keep links in supervised emails on the environment that initiated the send.
 * The production origin remains the safe fallback for legacy deployments that
 * have not declared SITE_URL yet.
 */
export function informationAgentAppOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveSiteOrigin(env, "https://immojudis.com") ?? "https://immojudis.com";
}

export function informationAgentCaseReference(caseId: string): string {
  return `IJ-${caseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

async function updateCaseOrThrow(
  caseId: string,
  values: Database["public"]["Tables"]["information_agent_cases"]["Update"],
) {
  const { error } = await supabaseAdmin
    .from("information_agent_cases")
    .update(values)
    .eq("id", caseId);
  if (error) throw error;
}

async function listFactsForCases(caseIds: string[]): Promise<InformationAgentFact[]> {
  const uniqueCaseIds = [...new Set(caseIds)];
  if (!uniqueCaseIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("*")
    .in("case_id", uniqueCaseIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((fact) => ({
    id: fact.id,
    caseId: fact.case_id,
    factKey: fact.fact_key,
    displayValue: fact.display_value,
    confidence: fact.confidence,
    status: fact.status,
    evidenceExcerpt: fact.evidence_excerpt,
    createdAt: fact.created_at,
    reviewedAt: fact.reviewed_at,
  }));
}

function uniqueQuestionKeys(keys: readonly InformationAgentQuestionKey[]) {
  return [...new Set(keys)].slice(0, 8);
}

function isQuestionKey(value: string): value is InformationAgentQuestionKey {
  return value in INFORMATION_AGENT_QUESTIONS;
}

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
