import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RateLimitError } from "@/lib/api-errors";
import { serverEnv } from "@/lib/env";
import { postGitHubWorkflowDispatch } from "@/lib/github-workflow-dispatch.server";
import { enforceGlobalRateLimit } from "@/lib/rate-limit";

/** Workflow d'analyse des réponses de l'agent (voir `.github/workflows/information-agent-evidence.yml`). */
const INFORMATION_AGENT_EVIDENCE_WORKFLOW = "information-agent-evidence.yml";

/**
 * Toujours `main`, quelle que soit `GITHUB_SCROLL_REF` : le workflow reçoit la clé de service de la production et
 * refuse toute autre branche (`if: github.ref == 'refs/heads/main'`). Une autre référence ne lancerait rien.
 */
const INFORMATION_AGENT_EVIDENCE_DISPATCH_REF = "main";

/**
 * Au plus un déclenchement par tranche de 10 minutes, tenu en base par le limiteur global
 * (`consume_ip_rate_limit`, fenêtre fixe alignée sur l'horloge). Le workflow a de plus un groupe de concurrence :
 * un déclenchement pendant une analyse en cours attend la fin de celle-ci.
 */
export const INFORMATION_AGENT_EVIDENCE_DISPATCH_LIMIT = { limit: 1, windowSeconds: 600 } as const;
/**
 * Disjoncteur : au plus 24 déclenchements par jour (UTC), même limiteur. Le plafond de 3 essais d'une analyse
 * n'augmente qu'à la prise en charge par le worker : si le workflow échoue avant (installation, secret,
 * import), la ligne reste prenable et serait redéclenchée sans fin.
 */
export const INFORMATION_AGENT_EVIDENCE_DISPATCH_DAILY_LIMIT = {
  limit: 24,
  windowSeconds: 24 * 60 * 60,
} as const;
/** Au-delà, la plus ancienne analyse prenable est « figée » : plus de déclenchement, l'horaire GitHub reste. */
const INFORMATION_AGENT_EVIDENCE_STALLED_AFTER_MS = 2 * 60 * 60 * 1000;
const DISPATCH_BUCKET_KEY = "information-agent.evidence-dispatch";
const DAILY_BUCKET_KEY = "information-agent.evidence-dispatch.daily";

/** Même délai que `claim_information_agent_evidence_extractions` pour reprendre une analyse abandonnée. */
const STALE_PROCESSING_MS = 45 * 60 * 1000;

export type InformationAgentEvidenceDispatchOutcome =
  | { status: "not_pending" }
  | { status: "throttled" }
  | { status: "daily_cap" }
  | { status: "stalled"; oldestWaitingMinutes: number }
  | { status: "token_missing" }
  | { status: "dispatched"; workflow: string; ref: string }
  | { status: "failed"; reason: string };

/** Échec à une étape connue : seul le nom de l'étape est tracé. */
class EvidenceDispatchStageError extends Error {}

/**
 * Date de création de la plus ancienne analyse que le worker prendrait maintenant (null : aucune). Mêmes
 * conditions que la RPC de prise en charge : moins de 3 essais, échéance passée, en file ou en échec, ou en
 * cours mais abandonnée depuis 45 minutes.
 */
async function oldestClaimableEvidenceExtraction(now: Date): Promise<Date | null> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("information_agent_evidence_extractions")
    .select("created_at")
    .lt("attempts", 3)
    .lte("available_at", now.toISOString())
    .or(`status.in.(queued,failed),and(status.eq.processing,locked_at.lt.${staleBefore})`)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new EvidenceDispatchStageError("pending_check_failed");
  const createdAt = data?.[0]?.created_at;
  if (!createdAt) return null;
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

async function consume(bucketKey: string, limits: { limit: number; windowSeconds: number }) {
  try {
    await enforceGlobalRateLimit({ bucketKey, ...limits });
    return true;
  } catch (error) {
    if (error instanceof RateLimitError) return false;
    throw new EvidenceDispatchStageError("rate_limit_unavailable");
  }
}

/**
 * Déclenche le workflow d'analyse quand au moins une analyse attend. Ne lève jamais : un échec est tracé (étape et
 * statut HTTP seulement, ni adresse ni contenu) et l'horaire GitHub du workflow reste le filet.
 */
export async function dispatchPendingInformationAgentEvidence({
  now = new Date(),
  fetcher = fetch,
}: { now?: Date; fetcher?: typeof fetch } = {}): Promise<InformationAgentEvidenceDispatchOutcome> {
  let outcome: InformationAgentEvidenceDispatchOutcome;
  try {
    outcome = await dispatchWhenPending(now, fetcher);
  } catch (error) {
    outcome = {
      status: "failed",
      reason:
        error instanceof EvidenceDispatchStageError
          ? error.message
          : error instanceof Error && error.name === "TimeoutError"
            ? "dispatch_timeout"
            : "dispatch_error",
    };
  }
  if (outcome.status === "failed" || outcome.status === "token_missing") {
    console.warn("[Information agent] Evidence analysis dispatch skipped", outcome);
  }
  return outcome;
}

async function dispatchWhenPending(
  now: Date,
  fetcher: typeof fetch,
): Promise<InformationAgentEvidenceDispatchOutcome> {
  const oldest = await oldestClaimableEvidenceExtraction(now);
  if (!oldest) return { status: "not_pending" };
  const waitingMs = now.getTime() - oldest.getTime();
  if (waitingMs > INFORMATION_AGENT_EVIDENCE_STALLED_AFTER_MS) {
    return { status: "stalled", oldestWaitingMinutes: Math.floor(waitingMs / 60_000) };
  }

  // Le jeton est lu après la tranche de 10 minutes : un jeton absent n'est tracé qu'une fois par tranche.
  if (!(await consume(DISPATCH_BUCKET_KEY, INFORMATION_AGENT_EVIDENCE_DISPATCH_LIMIT))) {
    return { status: "throttled" };
  }
  const { githubToken: token, repository } = serverEnv().pipeline;
  if (!token) return { status: "token_missing" };
  if (!(await consume(DAILY_BUCKET_KEY, INFORMATION_AGENT_EVIDENCE_DISPATCH_DAILY_LIMIT))) {
    return { status: "daily_cap" };
  }

  const response = await postGitHubWorkflowDispatch({
    token,
    repository,
    workflow: INFORMATION_AGENT_EVIDENCE_WORKFLOW,
    ref: INFORMATION_AGENT_EVIDENCE_DISPATCH_REF,
    fetcher,
  });
  // Seul le statut est retenu : la réponse de GitHub n'est pas journalisée.
  if (!response.ok) return { status: "failed", reason: `http_${response.status}` };
  return {
    status: "dispatched",
    workflow: INFORMATION_AGENT_EVIDENCE_WORKFLOW,
    ref: INFORMATION_AGENT_EVIDENCE_DISPATCH_REF,
  };
}
