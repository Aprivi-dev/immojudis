import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { adminPageQueryShape } from "@/lib/admin-page-query";
import type { AdminPageMeta } from "@/lib/admin-pagination";
import type { InformationAgentInventoryItem } from "@/lib/information-agent-inventory";
import {
  INFORMATION_AGENT_QUESTIONS,
  type InformationAgentGap,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import type {
  InformationAgentContactCandidate,
  InformationAgentRecipientKind,
} from "@/lib/information-agent/contacts";
import type { INFORMATION_AGENT_COURT_REGISTRY_FALLBACK } from "@/lib/information-agent/court-registry-fallback";

// Schémas zod et types de l'agent d'information. Module sans accès réseau ni base, réexporté par
// `information-agent.ts` (les imports existants ne changent pas).

/** Valeur de `metadata.send_outcome` d'un envoi dont on ignore s'il est parti. */
export const UNVERIFIED_SEND_OUTCOME = "unverified";

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];
type FactRow = Database["public"]["Tables"]["information_agent_fact_candidates"]["Row"];

const QUESTION_KEYS = Object.keys(INFORMATION_AGENT_QUESTIONS) as [
  InformationAgentQuestionKey,
  ...InformationAgentQuestionKey[],
];

export const informationAgentCreateSchema = z.object({
  saleId: z.string().guid(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  recipientName: z.string().trim().max(180).optional(),
  questionKeys: z.array(z.enum(QUESTION_KEYS)).min(1).max(8).optional(),
});

export const informationAgentListQuerySchema = z.object({
  saleId: z.string().guid().optional(),
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
  missionId: z.string().guid(),
  ...editableMessageFields,
});
export type InformationAgentPreviewInput = z.output<typeof informationAgentPreviewSchema>;

// The admin workflow deliberately does not expose the former end-user consent
// flag. Admins are the sole initiators of these requests and the requester
// email is never shared with the professional contact.
export const informationAgentAdminActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve_and_send"),
    missionId: z.string().guid(),
    approvalConfirmed: z.literal(true),
    /** Empreinte rendue par l'aperçu de ce contenu exact : sans aperçu, aucun envoi. */
    previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Aperçu requis avant l'envoi."),
    ...editableMessageFields,
  }),
  z.object({
    action: z.literal("cancel"),
    missionId: z.string().guid(),
  }),
  z.object({
    action: z.literal("record_reply"),
    missionId: z.string().guid(),
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
  /** `unverified` : l'envoi a dépassé le délai de Resend, l'email est peut-être parti (à vérifier). */
  sendOutcome: typeof UNVERIFIED_SEND_OUTCOME | null;
  approvedAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Titre de la vente, renseigné par la liste admin seulement (jamais par l'e-mail ni le dépôt). */
  saleTitle?: string | null;
  /** `court_registry_fallback` : le destinataire est le greffe du tribunal (aucun avocat trouvé), pas un avocat. */
  recipientOrigin?: typeof INFORMATION_AGENT_COURT_REGISTRY_FALLBACK | null;
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

/**
 * Déclencheur interne d'un envoi : le pilote automatique (`information-agent-autopilot.ts`). Hors du schéma zod :
 * jamais lu d'une requête HTTP. Absent : envoi manuel d'un administrateur.
 *
 * Valeur opaque : elle ne se fabrique que par `issueAutopilotTrigger`, importé par le seul module du pilote (le
 * verrou `information-agent-no-automatic-send.test.ts` le vérifie), et `send.ts` / `draft.ts` refusent tout
 * déclencheur qui n'a pas été émis ainsi. Un objet `{ kind: "autopilot" }` écrit ailleurs est donc inopérant.
 */
export type InformationAgentSendTrigger = {
  readonly kind: "autopilot";
  readonly runId: string;
  /** Résultat des contrôles du pilote, repris dans la trace de l'envoi (codes et nombres, jamais d'adresse). */
  readonly checks?: Readonly<Record<string, string | number | boolean | null>>;
};

const issuedTriggers = new WeakSet<object>();

export function issueAutopilotTrigger(
  runId: string,
  checks?: Record<string, string | number | boolean | null>,
): InformationAgentSendTrigger {
  const trigger = Object.freeze({ kind: "autopilot" as const, runId, checks });
  issuedTriggers.add(trigger);
  return trigger;
}

/** Refuse un déclencheur qui n'a pas été émis par `issueAutopilotTrigger`. */
export function assertIssuedAutopilotTrigger(
  trigger: InformationAgentSendTrigger | undefined,
): void {
  if (trigger && !issuedTriggers.has(trigger)) {
    throw new Error("Déclencheur d'envoi automatique non reconnu.");
  }
}
