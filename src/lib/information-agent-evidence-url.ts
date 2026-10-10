import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertSalePublicationVisible } from "@/lib/sale-publication-guard";

export const APPROVED_EVIDENCE_BUCKET = "information-agent-approved";
export const APPROVED_EVIDENCE_URL_TTL_SECONDS = 10 * 60;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const APPROVED_PATH = new RegExp(
  `^(${UUID})/${UUID}/(?:photo|piece-jointe)-[0-9a-f-]{36}\\.(?:webp|pdf)$`,
);

export function parseApprovedEvidencePath(value: string | null): { saleId: string } | null {
  if (!value || value.length > 200) return null;
  const match = APPROVED_PATH.exec(value);
  return match ? { saleId: match[1] } : null;
}

/**
 * Signs a published attachment for 10 minutes. Only objects that an administrator accepted for a
 * sale that is currently visible in the catalogue can be signed; anything else yields null so the
 * caller answers a uniform 404.
 */
export async function createApprovedEvidenceSignedUrl(path: string | null): Promise<string | null> {
  const parsed = parseApprovedEvidencePath(path);
  if (!parsed || !path) return null;

  try {
    await assertSalePublicationVisible(parsed.saleId);
  } catch {
    return null;
  }

  const { data: fact, error } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id")
    .eq("sale_id", parsed.saleId)
    .eq("status", "accepted")
    .filter("proposed_value->>public_path", "eq", path)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!fact) return null;

  const { data, error: signError } = await supabaseAdmin.storage
    .from(APPROVED_EVIDENCE_BUCKET)
    .createSignedUrl(path, APPROVED_EVIDENCE_URL_TTL_SECONDS);
  if (signError || !data?.signedUrl) return null;
  return data.signedUrl;
}
