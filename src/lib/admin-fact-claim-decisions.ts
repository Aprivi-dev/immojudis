import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { canonicalValue, loadSaleSummaries } from "@/lib/admin-auction-fact-claims-review";
import { adminPageQueryShape } from "@/lib/admin-page-query";
import { adminPageMeta, type AdminPageMeta } from "@/lib/admin-pagination";
import {
  allowedFactClaimDecisionActions,
  FACT_CLAIM_LOT_ATTACHMENTS,
  FACT_CLAIM_REJECT_REASONS,
  FACT_CLAIM_RESERVED_EVIDENCE_KINDS,
  FACT_CLAIM_WITHDRAW_REASONS,
  type FactClaimDecisionAction,
} from "@/lib/fact-claim-decisions";

/**
 * Registre des pièces, écran de décision (lot R2c) : lecture des observations d'une vente avec
 * leur dernière décision, et écriture d'une décision AU NOM de l'administrateur connecté.
 */

function keysOf<K extends string>(record: Record<K, string>): [K, ...K[]] {
  return Object.keys(record) as [K, ...K[]];
}

export const adminFactClaimDecisionQuerySchema = z.object({
  ...adminPageQueryShape,
  saleId: z.string().guid().optional(),
});

/** Corps strict : une clé inconnue est refusée, et chaque décision n'admet que ses propres champs. */
export const adminFactClaimDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("accept"),
    claimId: z.string().guid(),
    lotAttachment: z.enum(keysOf(FACT_CLAIM_LOT_ATTACHMENTS)),
    // Même borne que la colonne lot_ref ; la base normalise le libellé et l'écarte s'il sort du motif.
    lotRef: z.string().trim().min(1).max(40).optional(),
    // Dernière décision vue par l'administrateur : la base refuse si une autre l'a suivie.
    supersedesDecisionId: z.string().guid().optional(),
  }),
  z.strictObject({
    action: z.literal("reject"),
    claimId: z.string().guid(),
    reasonCode: z.enum(keysOf(FACT_CLAIM_REJECT_REASONS)),
  }),
  z.strictObject({
    action: z.literal("withdraw"),
    claimId: z.string().guid(),
    reasonCode: z.enum(keysOf(FACT_CLAIM_WITHDRAW_REASONS)),
  }),
  z.strictObject({
    action: z.literal("oppose"),
    claimId: z.string().guid(),
  }),
]);

export type AdminFactClaimDecisionQuery = z.output<typeof adminFactClaimDecisionQuerySchema>;
export type AdminFactClaimDecisionInput = z.output<typeof adminFactClaimDecisionSchema>;

export type AdminFactClaimDecisionItem = {
  claimId: string;
  saleId: string;
  fieldKey: string;
  /** Valeur proposée par l'observation. */
  value: unknown;
  /** Valeur que la fiche affiche aujourd'hui. Absente : champ sans colonne connue, non comparé. */
  currentValue?: unknown;
  /** Nature de la pièce (`evidence_kind`). */
  origin: string;
  /** Lien vers la source, seulement s'il est en http(s). */
  sourceUrl: string | null;
  capturedAt: string;
  sale: { title: string | null; city: string | null; saleDate: string | null };
  latestDecision: {
    id: string;
    decision: string;
    reasonCode: string | null;
    lotAttachment: string;
    decidedAt: string;
  } | null;
  allowedActions: FactClaimDecisionAction[];
};

export type AdminFactClaimDecisionListResponse = AdminPageMeta & {
  ok: true;
  items: AdminFactClaimDecisionItem[];
};

export type AdminFactClaimDecisionResult = {
  ok: true;
  result: {
    claimId: string | null;
    decisionId: string | null;
    decision: string | null;
    saleId: string | null;
    fieldKey: string | null;
    /** État du champ après la projection ; « held » quand la valeur est affichée. */
    state: string | null;
  };
};

const CLAIM_COLUMNS =
  "claim_id,auction_sale_id,field_key,value_jsonb,evidence_kind,source_url,captured_at,created_at";

type ClaimRow = {
  claim_id: string;
  auction_sale_id: string;
  field_key: string;
  value_jsonb: unknown;
  evidence_kind: string;
  source_url: string | null;
  captured_at: string;
};

type ClaimQuery = PromiseLike<{
  data: unknown[] | null;
  error: unknown;
  count?: number | null;
}> & {
  select(columns: string, options: { count: "exact" }): ClaimQuery;
  in(column: string, values: string[]): ClaimQuery;
  eq(column: string, value: string): ClaimQuery;
  not(column: string, operator: string, value: null): ClaimQuery;
  order(column: string, options: { ascending: boolean }): ClaimQuery;
  range(from: number, to: number): ClaimQuery;
};

/**
 * Observations à décider. Lecture par le rôle de service : la vue et le journal des décisions
 * sont fermés aux rôles du navigateur. L'appelant a déjà vérifié le rôle administrateur
 * (`requireAdmin` dans la route), comme pour toute lecture par le rôle de service.
 */
export async function listAdminFactClaimDecisions(
  input: AdminFactClaimDecisionQuery,
): Promise<AdminFactClaimDecisionListResponse> {
  const query = (supabaseAdmin as unknown as { from(view: string): ClaimQuery })
    .from("v_auction_fact_claims_read_model")
    .select(CLAIM_COLUMNS, { count: "exact" })
    .not("auction_sale_id", "is", null)
    .order("created_at", { ascending: false })
    .order("claim_id", { ascending: true });
  // Sans vente choisie, la file ne montre que les natures que le registre réserve : les
  // observations de la collecte se relisent dans « Faits à vérifier ».
  const filtered = input.saleId
    ? query.eq("auction_sale_id", input.saleId)
    : query.in("evidence_kind", Object.keys(FACT_CLAIM_RESERVED_EVIDENCE_KINDS));

  const { data, error, count } = await filtered.range(input.offset, input.offset + input.limit - 1);
  if (error) throw error;
  const rows = (data ?? []).filter(isClaimRow);

  const [sales, latestDecisions] = await Promise.all([
    loadSaleSummaries(rows.map((row) => row.auction_sale_id)),
    loadLatestDecisions(rows.map((row) => row.claim_id)),
  ]);

  return {
    ok: true,
    items: rows.flatMap((row) => {
      const sale = sales.get(row.auction_sale_id);
      if (!sale) return [];
      const latestDecision = latestDecisions.get(row.claim_id) ?? null;
      return [
        {
          claimId: row.claim_id,
          saleId: row.auction_sale_id,
          fieldKey: row.field_key,
          value: row.value_jsonb,
          currentValue: canonicalValue(row.field_key, sale),
          origin: row.evidence_kind,
          sourceUrl: httpUrl(row.source_url),
          capturedAt: row.captured_at,
          sale: { title: sale.title, city: sale.city, saleDate: sale.saleDate },
          latestDecision,
          allowedActions: allowedFactClaimDecisionActions(latestDecision),
        },
      ];
    }),
    ...adminPageMeta({
      offset: input.offset,
      limit: input.limit,
      total: count ?? input.offset + rows.length,
    }),
  };
}

/**
 * Écrit une décision par le client Supabase de la session (`auth.supabase`, porteur du jeton de
 * l'administrateur), JAMAIS par le client de service : la base lit l'auteur dans le jeton
 * (`auth.uid()`), vérifie elle-même le rôle, et répond `admin_required` au rôle de service.
 */
export async function decideAdminFactClaim({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: AdminFactClaimDecisionInput;
}): Promise<AdminFactClaimDecisionResult> {
  const { data, error } = await callDecision(auth.supabase, input);
  if (error) throw error;
  const result = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const text = (key: string) => {
    const value = (result as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  };
  return {
    ok: true,
    result: {
      claimId: text("claim_id"),
      decisionId: text("decision_id"),
      decision: text("decision"),
      saleId: text("sale_id"),
      fieldKey: text("field_key"),
      state: text("state"),
    },
  };
}

function callDecision(client: SupabaseAuthContext["supabase"], input: AdminFactClaimDecisionInput) {
  switch (input.action) {
    case "accept":
      return client.rpc("accept_auction_fact_claim", {
        p_claim_id: input.claimId,
        p_lot_attachment: input.lotAttachment,
        p_lot_ref: input.lotRef,
        p_supersedes_decision_id: input.supersedesDecisionId,
      });
    case "reject":
      return client.rpc("reject_auction_fact_claim", {
        p_claim_id: input.claimId,
        p_reason_code: input.reasonCode,
      });
    case "withdraw":
      return client.rpc("withdraw_auction_fact_claim", {
        p_claim_id: input.claimId,
        p_reason_code: input.reasonCode,
      });
    case "oppose":
      // Motif par défaut de la base : « professional_opposition ».
      return client.rpc("oppose_auction_fact_claim", { p_claim_id: input.claimId });
  }
}

/** Dernière décision de chaque observation, dans l'ordre de `seq` (jamais d'une date). */
async function loadLatestDecisions(
  claimIds: string[],
): Promise<Map<string, NonNullable<AdminFactClaimDecisionItem["latestDecision"]>>> {
  const latest = new Map<string, NonNullable<AdminFactClaimDecisionItem["latestDecision"]>>();
  if (!claimIds.length) return latest;
  const { data, error } = await supabaseAdmin
    .from("auction_fact_claim_decisions")
    .select("id,claim_id,decision,reason_code,lot_attachment,decided_at")
    .in("claim_id", claimIds)
    .order("seq", { ascending: false });
  if (error) throw error;
  for (const row of data ?? []) {
    if (latest.has(row.claim_id)) continue;
    latest.set(row.claim_id, {
      id: row.id,
      decision: row.decision,
      reasonCode: row.reason_code,
      lotAttachment: row.lot_attachment,
      decidedAt: row.decided_at,
    });
  }
  return latest;
}

function isClaimRow(value: unknown): value is ClaimRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.claim_id === "string" &&
    typeof row.auction_sale_id === "string" &&
    typeof row.field_key === "string" &&
    typeof row.evidence_kind === "string" &&
    typeof row.captured_at === "string"
  );
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
