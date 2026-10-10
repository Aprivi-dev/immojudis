import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeEmail } from "@/lib/account";
import {
  AdminRouteTimeoutError,
  adminDeadlineSignal,
  throwIfAdminDeadlineExceeded,
} from "@/lib/admin-route-deadline";
import { serverEnv } from "@/lib/env";

const SCROLL_SOURCES = [
  "all",
  "avoventes",
  "licitor",
  "vench",
  "info_encheres",
  "encheres_publiques",
  "petites_affiches",
  "cessions_etat",
  "agrasc",
  "encheres_immobilieres",
  "notaires",
] as const;

const startScrollSchema = z
  .object({
    source: z.enum(SCROLL_SOURCES).default("all"),
    mode: z.enum(["collect", "llm_backfill"]).default("collect"),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.mode === "llm_backfill" && data.source !== "all") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "Le backfill LLM doit cibler la source all.",
      });
    }
  });
const AUTOMATIC_LLM_ENRICHMENT = true;
const LLM_BACKFILL_SOURCE = "llm-description-backfill";
const EXPECTED_LLM_PROMPT_VERSION = "auction_llm_v10_structured_display";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type RunnerMode = "github_actions" | "webhook" | "queue_worker";
export type RunnerStatus = "active" | "suspended" | "unknown";

export type AdminScrollSource = (typeof SCROLL_SOURCES)[number];
export type AdminScrollMode = "collect" | "llm_backfill";

export type AuctionRun = {
  id: string;
  status: string;
  source: string | null;
  useLlm: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  summary: JsonObject;
  errors: JsonObject;
};

export type AiDescriptionDashboardStats = {
  expectedPromptVersion: string;
  total: number;
  activeOrUpcoming: number;
  ready: number;
  missing: number;
  promptVersionMismatch: number;
  backfillRemaining: number;
};

export type AdminDashboardData = {
  checkedAt: string;
  adminEmail: string;
  runner: {
    instantDispatchConfigured: boolean;
    mode: RunnerMode;
    controlEnabled?: boolean | null;
    status?: RunnerStatus;
  };
  stats: {
    sales: number;
    documents: number;
    extractions: number;
    riskOccurrences: number;
    scoreFactors: number;
    runs: number;
    queuedRuns: number;
    runningRuns: number;
    failedRuns: number;
    aiDescriptions: AiDescriptionDashboardStats;
  };
  runs: AuctionRun[];
};

/**
 * Le tableau de bord est découpé en sections pour que chaque vue admin ne calcule que ce qu'elle
 * affiche : `runs` (rapide : 25 derniers runs, état du runner), `ai` (lecture de toutes les
 * synthèses IA : la partie coûteuse) et `counts` (comptages exacts de six tables).
 */
export const ADMIN_DASHBOARD_SECTIONS = ["runs", "ai", "counts"] as const;
export type AdminDashboardSection = (typeof ADMIN_DASHBOARD_SECTIONS)[number];
export const adminDashboardQuerySchema = z
  .object({ section: z.enum(ADMIN_DASHBOARD_SECTIONS).optional() })
  .strict();

export type AdminDashboardRunsData = {
  checkedAt: string;
  adminEmail: string;
  runner: AdminDashboardData["runner"];
  stats: Pick<AdminDashboardData["stats"], "queuedRuns" | "runningRuns" | "failedRuns">;
  runs: AuctionRun[];
};

export type AdminDashboardAiData = {
  checkedAt: string;
  aiDescriptions: AiDescriptionDashboardStats;
};

export type AdminDashboardCountsData = {
  checkedAt: string;
  counts: Pick<
    AdminDashboardData["stats"],
    "sales" | "documents" | "extractions" | "riskOccurrences" | "scoreFactors" | "runs"
  >;
};

export type StartScrollResult = {
  ok: boolean;
  message: string;
  dispatched: boolean;
  dispatchMode: RunnerMode;
  run: AuctionRun;
};

type QueryError = {
  message?: string;
};

type QueryResult<T> = {
  data: T[] | null;
  error: QueryError | null;
  count?: number | null;
};

type QueryBuilder<T> = PromiseLike<QueryResult<T>> & {
  order: (
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  range: (from: number, to: number) => QueryBuilder<T>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
};

type TableClient<T> = {
  select: (columns?: string, options?: { count?: "exact"; head?: boolean }) => QueryBuilder<T>;
  insert: (payload: unknown) => {
    select: (columns?: string) => QueryBuilder<T>;
  };
  update: (payload: unknown) => {
    eq: (column: string, value: unknown) => UpdateQuery<T>;
  };
};

type UpdateQuery<T> = PromiseLike<{ data?: T[] | null; error: QueryError | null }> & {
  eq: (column: string, value: unknown) => UpdateQuery<T>;
  select: (columns?: string) => QueryBuilder<T>;
};

type AdminClient = {
  from: <T>(table: string) => TableClient<T>;
  auth: {
    admin: {
      getUserById: (userId: string) => Promise<{
        data: { user: { email?: string | null } | null };
        error: QueryError | null;
      }>;
    };
  };
};

type AdminContext = {
  userId: string;
  claims?: JsonObject;
  isAdmin: boolean;
};

type AuctionRunRow = {
  id?: string | null;
  status?: string | null;
  source?: string | null;
  use_llm?: boolean | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  summary?: unknown;
  errors?: unknown;
};

type AuctionSaleAiDescriptionRow = {
  status?: string | null;
  llm_display_description?: unknown;
  llm_prompt_version?: unknown;
  llm_display_quality_version?: unknown;
  llm_display_status?: unknown;
};

type PipelineControlRow = {
  enabled?: boolean | null;
};

const RUN_COLUMNS =
  "id,status,source,use_llm,started_at,finished_at,summary,errors,created_at,updated_at";
const AI_DESCRIPTION_COLUMNS =
  "status,llm_display_description:raw_payload->llm_display_description,llm_prompt_version:raw_payload->llm_prompt_version,llm_display_quality_version:raw_payload->llm_display_quality_version,llm_display_status:raw_payload->llm_display_status";
const AI_DESCRIPTION_PAGE_SIZE = 1000;

function getAdminClient(): AdminClient {
  return supabaseAdmin as unknown as AdminClient;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (toJsonValue(value) as JsonObject)
    : {};
}

function normalizeRun(row: AuctionRunRow): AuctionRun {
  return {
    id: String(row.id ?? ""),
    status: String(row.status ?? "unknown"),
    source: row.source ?? null,
    useLlm: typeof row.use_llm === "boolean" ? row.use_llm : null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    summary: asObject(row.summary),
    errors: asObject(row.errors),
  };
}

function claimEmail(context: AdminContext): string | null {
  const value = context.claims?.email;
  return typeof value === "string" ? value : null;
}

async function assertAdminContext(context: AdminContext): Promise<{ email: string }> {
  const email = claimEmail(context);

  if (context.isAdmin) {
    return { email: normalizeEmail(email) || "admin" };
  }

  throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
}

async function countRows(table: string): Promise<number> {
  const admin = getAdminClient();
  const { count, error } = await admin
    .from<Record<string, never>>(table)
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message ?? `Erreur de lecture ${table}`);
  return count ?? 0;
}

function statusCount(runs: AuctionRun[], status: string): number {
  return runs.filter((run) => run.status === status).length;
}

function cleanPayloadText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isActiveOrUpcomingStatus(status: unknown): boolean {
  return status === "active" || status === "upcoming";
}

export function buildAiDescriptionDashboardStats(
  rows: AuctionSaleAiDescriptionRow[],
  expectedPromptVersion = EXPECTED_LLM_PROMPT_VERSION,
): AiDescriptionDashboardStats {
  let activeOrUpcoming = 0;
  let ready = 0;
  let missing = 0;
  let promptVersionMismatch = 0;

  for (const row of rows) {
    if (!isActiveOrUpcomingStatus(row.status)) continue;
    activeOrUpcoming += 1;
    const displayDescription = cleanPayloadText(row.llm_display_description);
    const promptVersion = cleanPayloadText(row.llm_prompt_version);
    if (!displayDescription) {
      missing += 1;
    }
    if (promptVersion !== expectedPromptVersion) {
      promptVersionMismatch += 1;
    }
    if (
      displayDescription &&
      displayDescription.length >= 80 &&
      promptVersion === expectedPromptVersion &&
      row.llm_display_quality_version === "display_quality_20260911_v3" &&
      ["accepted", "fallback"].includes(String(row.llm_display_status))
    ) {
      ready += 1;
    }
  }

  return {
    expectedPromptVersion,
    total: rows.length,
    activeOrUpcoming,
    ready,
    missing,
    promptVersionMismatch,
    backfillRemaining: activeOrUpcoming - ready,
  };
}

export async function readAiDescriptionStats(
  admin: AdminClient,
): Promise<AiDescriptionDashboardStats> {
  const rows: AuctionSaleAiDescriptionRow[] = [];

  for (let from = 0; ; from += AI_DESCRIPTION_PAGE_SIZE) {
    // Arrête la lecture de tout le catalogue dès que la route a répondu 504.
    throwIfAdminDeadlineExceeded();
    const to = from + AI_DESCRIPTION_PAGE_SIZE - 1;
    const result = await admin
      .from<AuctionSaleAiDescriptionRow>("auction_sales")
      .select(AI_DESCRIPTION_COLUMNS)
      .order("id", { ascending: true })
      .range(from, to);

    if (result.error) {
      throw new Error(result.error.message ?? "Impossible de lire les synthèses IA.");
    }

    const page = result.data ?? [];
    rows.push(...page);

    if (page.length < AI_DESCRIPTION_PAGE_SIZE) {
      return buildAiDescriptionDashboardStats(rows);
    }
  }
}

/**
 * La lecture des synthèses IA parcourt `raw_payload` de toutes les ventes (≈ 100 Mo compressés au
 * 10 octobre 2026). Le tableau de bord la redemandait toutes les 10 s tant qu'un run était actif ;
 * plusieurs onglets ouverts empilaient alors des lectures complètes. Le résultat est donc gardé
 * 60 s et les appels simultanés partagent une seule lecture.
 */
const AI_STATS_TTL_MS = 60_000;
let aiStatsCache: { expiresAt: number; value: AiDescriptionDashboardStats } | null = null;
let aiStatsInflight: Promise<AiDescriptionDashboardStats> | null = null;

export function resetAiDescriptionStatsCache(): void {
  aiStatsCache = null;
  aiStatsInflight = null;
}

export async function readAiDescriptionStatsCached(
  admin: AdminClient,
  now: () => number = Date.now,
): Promise<AiDescriptionDashboardStats> {
  if (aiStatsCache && aiStatsCache.expiresAt > now()) return aiStatsCache.value;
  for (let attempt = 0; ; attempt += 1) {
    const inflight =
      aiStatsInflight ??
      (aiStatsInflight = readAiDescriptionStats(admin)
        .then((value) => {
          aiStatsCache = { expiresAt: now() + AI_STATS_TTL_MS, value };
          return value;
        })
        .finally(() => {
          aiStatsInflight = null;
        }));
    try {
      return await inflight;
    } catch (error) {
      // La lecture partagée a été interrompue par le délai d'une autre requête : on la relance
      // une fois pour cette requête-ci, qui dispose encore de son propre délai.
      const abortedByOtherRequest =
        error instanceof AdminRouteTimeoutError && !adminDeadlineSignal()?.aborted;
      if (!abortedByOtherRequest || attempt >= 1) throw error;
    }
  }
}

function scrollWebhookUrl(): string | null {
  return serverEnv().pipeline.webhookUrl ?? null;
}

function scrollWebhookSecret(): string | null {
  return serverEnv().pipeline.webhookSecret ?? null;
}

function githubActionsToken(): string | null {
  return serverEnv().pipeline.githubToken ?? null;
}

function githubActionsRepository(): string {
  return serverEnv().pipeline.repository;
}

function githubActionsWorkflow(): string {
  return serverEnv().pipeline.workflow;
}

function githubActionsRef(): string {
  return serverEnv().pipeline.ref;
}

function runnerMode(): RunnerMode {
  if (githubActionsToken()) return "github_actions";
  if (scrollWebhookUrl()) return "webhook";
  return "queue_worker";
}

async function updateRunSummary(runId: string, summary: JsonObject, errors: JsonObject) {
  const admin = getAdminClient();
  const { error } = await admin
    .from<AuctionRunRow>("auction_runs")
    .update({ summary, errors })
    .eq("id", runId);
  if (error) throw new Error(error.message ?? "Impossible de mettre à jour le run.");
}

async function readRun(runId: string): Promise<AuctionRun> {
  const admin = getAdminClient();
  const result = await admin
    .from<AuctionRunRow>("auction_runs")
    .select(RUN_COLUMNS)
    .eq("id", runId)
    .limit(1);
  if (result.error) throw new Error(result.error.message ?? "Impossible de relire le run.");
  const row = result.data?.[0];
  if (!row) throw new Error("Run introuvable après le lancement de la collecte.");
  return normalizeRun(row);
}

/**
 * A deterministic upstream rejection makes this run terminal. The status
 * predicate prevents a worker that won the race from being overwritten.
 */
async function markRunDispatchFailed(
  runId: string,
  summary: JsonObject,
  errors: JsonObject,
): Promise<AuctionRun> {
  const admin = getAdminClient();
  const finishedAt = new Date().toISOString();
  const result = await admin
    .from<AuctionRunRow>("auction_runs")
    .update({
      status: "failed",
      finished_at: finishedAt,
      updated_at: finishedAt,
      summary,
      errors,
    })
    .eq("id", runId)
    .eq("status", "queued")
    .select(RUN_COLUMNS)
    .limit(1);
  if (result.error) {
    throw new Error(result.error.message ?? "Impossible de clôturer le run rejeté.");
  }
  if (result.data?.[0]) return normalizeRun(result.data[0]);
  return readRun(runId);
}

async function dispatchGitHubActionsRun(
  run: AuctionRun,
  input: { source: AdminScrollSource; mode: AdminScrollMode; limit?: number },
): Promise<Response> {
  const token = githubActionsToken();
  if (!token) throw new Error("GitHub Actions token missing.");

  const repository = githubActionsRepository();
  const workflow = githubActionsWorkflow();
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;

  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: githubActionsRef(),
      inputs: {
        run_id: run.id,
        source: input.source,
        llm_backfill: String(input.mode === "llm_backfill"),
        ...(input.limit ? { limit: String(input.limit) } : {}),
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
}

async function readRunsSection(
  admin: AdminClient,
  adminEmail: string,
): Promise<AdminDashboardRunsData> {
  const [runsResult, pipelineControl] = await Promise.all([
    admin
      .from<AuctionRunRow>("auction_runs")
      .select(RUN_COLUMNS)
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(25),
    admin.from<PipelineControlRow>("auction_pipeline_control").select("enabled").limit(1),
  ]);

  if (runsResult.error) {
    throw new Error(runsResult.error.message ?? "Impossible de lire les runs.");
  }

  const runs = (runsResult.data ?? []).map(normalizeRun);
  const controlEnabled =
    pipelineControl.error || !pipelineControl.data?.length
      ? null
      : (pipelineControl.data[0]?.enabled ?? null);

  return {
    checkedAt: new Date().toISOString(),
    adminEmail,
    runner: {
      instantDispatchConfigured: runnerMode() !== "queue_worker",
      mode: runnerMode(),
      controlEnabled,
      status:
        controlEnabled === true ? "active" : controlEnabled === false ? "suspended" : "unknown",
    },
    stats: {
      queuedRuns: statusCount(runs, "queued"),
      runningRuns: statusCount(runs, "running"),
      failedRuns: statusCount(runs, "failed"),
    },
    runs,
  };
}

async function readCountsSection(): Promise<AdminDashboardCountsData> {
  const [sales, documents, extractions, riskOccurrences, scoreFactors, runs] = await Promise.all([
    countRows("auction_sales"),
    countRows("auction_documents"),
    countRows("auction_extractions"),
    countRows("auction_risk_occurrences"),
    countRows("auction_score_factors"),
    countRows("auction_runs"),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    counts: { sales, documents, extractions, riskOccurrences, scoreFactors, runs },
  };
}

/** Une seule section du tableau de bord : seule celle-ci est calculée. */
export async function getAdminDashboardSection(
  authToken: string,
  section: "runs",
): Promise<AdminDashboardRunsData>;
export async function getAdminDashboardSection(
  authToken: string,
  section: "ai",
): Promise<AdminDashboardAiData>;
export async function getAdminDashboardSection(
  authToken: string,
  section: "counts",
): Promise<AdminDashboardCountsData>;
export async function getAdminDashboardSection(
  authToken: string,
  section: AdminDashboardSection,
): Promise<AdminDashboardRunsData | AdminDashboardAiData | AdminDashboardCountsData>;
export async function getAdminDashboardSection(
  authToken: string,
  section: AdminDashboardSection,
): Promise<AdminDashboardRunsData | AdminDashboardAiData | AdminDashboardCountsData> {
  const context = await requireSupabaseAuthContext(authToken);
  const adminUser = await assertAdminContext(context as AdminContext);
  const admin = getAdminClient();
  if (section === "runs") return readRunsSection(admin, adminUser.email);
  if (section === "ai") {
    const aiDescriptions = await readAiDescriptionStatsCached(admin);
    return { checkedAt: new Date().toISOString(), aiDescriptions };
  }
  return readCountsSection();
}

/** Forme historique : toutes les sections en un seul appel (sans `?section=`). */
export async function getAdminDashboard(authToken: string): Promise<AdminDashboardData> {
  const context = await requireSupabaseAuthContext(authToken);
  const adminUser = await assertAdminContext(context as AdminContext);
  const admin = getAdminClient();
  const [runsData, countsData, aiDescriptions] = await Promise.all([
    readRunsSection(admin, adminUser.email),
    readCountsSection(),
    readAiDescriptionStatsCached(admin),
  ]);
  return {
    checkedAt: runsData.checkedAt,
    adminEmail: runsData.adminEmail,
    runner: runsData.runner,
    stats: { ...countsData.counts, ...runsData.stats, aiDescriptions },
    runs: runsData.runs,
  };
}

export async function startAdminScroll(
  authToken: string,
  input: unknown,
): Promise<StartScrollResult> {
  const context = await requireSupabaseAuthContext(authToken);
  const data = startScrollSchema.parse(input ?? {});
  const adminUser = await assertAdminContext(context as AdminContext);
  const mode = runnerMode();
  const webhookUrl = scrollWebhookUrl();
  if (mode === "queue_worker" || (mode === "webhook" && !webhookUrl)) {
    throw new Error(
      "Aucun runner de collecte n'est configuré. Configurez GITHUB_SCROLL_TOKEN ou SCROLL_WEBHOOK_URL avant de lancer une demande.",
    );
  }
  const admin = getAdminClient();
  const requestedAt = new Date().toISOString();
  const initialSummary = {
    requested_by: adminUser.email,
    requested_at: requestedAt,
    trigger: "admin_dashboard",
    mode: data.mode,
    ...(data.limit ? { limit: data.limit } : {}),
    runner_mode: mode,
    runner_expectation:
      mode === "github_actions"
        ? "dispatch_immediate"
        : mode === "webhook"
          ? "webhook_immediate"
          : "manual_dispatch_required",
  };

  const inserted = await admin
    .from<AuctionRunRow>("auction_runs")
    .insert({
      status: "queued",
      source: data.mode === "llm_backfill" ? LLM_BACKFILL_SOURCE : data.source,
      use_llm: AUTOMATIC_LLM_ENRICHMENT,
      summary: initialSummary,
      errors: {},
    })
    .select(RUN_COLUMNS)
    .limit(1);

  if (inserted.error) {
    throw new Error(inserted.error.message ?? "Impossible de créer la demande de collecte.");
  }

  const run = normalizeRun((inserted.data ?? [])[0] ?? {});
  if (!run.id) throw new Error("Demande créée sans identifiant de run.");

  if (mode === "github_actions") {
    let response: Response;
    try {
      response = await dispatchGitHubActionsRun(run, {
        source: data.source,
        mode: data.mode,
        limit: data.limit,
      });
    } catch (error) {
      const githubErrors = {
        ...run.errors,
        github_actions: error instanceof Error ? error.message : "GitHub Actions indisponible",
      };
      const githubSummary = {
        ...run.summary,
        github_actions: {
          attempted_at: new Date().toISOString(),
          repository: githubActionsRepository(),
          workflow: githubActionsWorkflow(),
          ref: githubActionsRef(),
          outcome: "unknown",
        },
      };
      await updateRunSummary(run.id, githubSummary, githubErrors);

      return {
        ok: false,
        dispatched: false,
        dispatchMode: "github_actions",
        run: {
          ...run,
          summary: githubSummary,
          errors: githubErrors,
        },
        message:
          "Demande enregistrée, mais le résultat du lancement GitHub Actions est indéterminé. Vérifiez l’exécution et le canal avant toute nouvelle action.",
      };
    }

    const githubSummary = {
      ...run.summary,
      github_actions: {
        dispatched_at: new Date().toISOString(),
        repository: githubActionsRepository(),
        workflow: githubActionsWorkflow(),
        ref: githubActionsRef(),
        status: response.status,
        ok: response.ok,
      },
    };
    if (response.ok) {
      await updateRunSummary(run.id, githubSummary, run.errors);
      return {
        ok: true,
        dispatched: true,
        dispatchMode: "github_actions",
        run: { ...run, summary: githubSummary },
        message: "Demande envoyée au worker GitHub Actions.",
      };
    }

    const githubErrors = {
      ...run.errors,
      github_actions: `HTTP ${response.status}`,
    };
    const failedRun = await markRunDispatchFailed(
      run.id,
      { ...githubSummary, completion_status: "dispatch_failed" },
      githubErrors,
    );
    const workerRace = failedRun.status !== "failed";
    return {
      ok: false,
      dispatched: false,
      dispatchMode: "github_actions",
      run: failedRun,
      message: workerRace
        ? `GitHub Actions a répondu HTTP ${response.status}, mais un worker a déjà pris le run. Vérifiez son état avant toute nouvelle action.`
        : `GitHub Actions a répondu HTTP ${response.status}. Le run est marqué en échec ; corrigez le canal puis relancez-le.`,
    };
  }

  if (!webhookUrl) {
    throw new Error(
      "Aucun runner de collecte n'est configuré. Configurez GITHUB_SCROLL_TOKEN ou SCROLL_WEBHOOK_URL avant de lancer une demande.",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = scrollWebhookSecret();
  if (secret) headers["X-Immojudis-Secret"] = secret;

  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runId: run.id,
        source: data.source,
        mode: data.mode,
        limit: data.limit,
        useLlm: AUTOMATIC_LLM_ENRICHMENT,
        requestedBy: adminUser.email,
        requestedAt,
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const webhookErrors = {
      ...run.errors,
      webhook: error instanceof Error ? error.message : "Webhook indisponible",
    };
    const webhookSummary = {
      ...run.summary,
      webhook: {
        attempted_at: new Date().toISOString(),
        outcome: "unknown",
      },
    };
    await updateRunSummary(run.id, webhookSummary, webhookErrors);

    return {
      ok: false,
      dispatched: false,
      dispatchMode: "webhook",
      run: {
        ...run,
        summary: webhookSummary,
        errors: webhookErrors,
      },
      message:
        "Demande enregistrée, mais le résultat du lancement webhook est indéterminé. Vérifiez l’exécution et le canal avant toute nouvelle action.",
    };
  }

  const webhookSummary = {
    ...run.summary,
    webhook: {
      dispatched_at: new Date().toISOString(),
      status: response.status,
      ok: response.ok,
    },
  };
  if (response.ok) {
    await updateRunSummary(run.id, webhookSummary, run.errors);
    return {
      ok: true,
      dispatched: true,
      dispatchMode: "webhook",
      run: { ...run, summary: webhookSummary },
      message: "Demande envoyée au runner de collecte.",
    };
  }

  const webhookErrors = {
    ...run.errors,
    webhook: `HTTP ${response.status}`,
  };
  const failedRun = await markRunDispatchFailed(
    run.id,
    { ...webhookSummary, completion_status: "dispatch_failed" },
    webhookErrors,
  );
  const workerRace = failedRun.status !== "failed";
  return {
    ok: false,
    dispatched: false,
    dispatchMode: "webhook",
    run: failedRun,
    message: workerRace
      ? `Le webhook a répondu HTTP ${response.status}, mais un worker a déjà pris le run. Vérifiez son état avant toute nouvelle action.`
      : `Le webhook a répondu HTTP ${response.status}. Le run est marqué en échec ; corrigez le canal puis relancez-le.`,
  };
}
