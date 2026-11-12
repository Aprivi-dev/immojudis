import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import type { AutopilotSettings, AutopilotStats } from "@/lib/information-agent/autopilot-rules";
import { informationAgentPortalSecret } from "@/lib/information-agent-signed-link";
import { assertInformationAgentControllerIdentity } from "@/lib/information-agent/message-guards";

/**
 * Version minimale de la politique de confidentialité sans laquelle le mode réel est REFUSÉ. Fixée volontairement
 * à une version FUTURE et non publiée : tant que le lot 3 (politique de confidentialité, pied « envoi
 * automatique », mise en balance, registre, AIPD signée) n'a pas publié une nouvelle version, le mode réel est
 * impossible. Le lot 3 abaisse cette constante à la version qu'il publie, dans le commit qui la publie.
 */
export const AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION = "2099-01-01.0";

const AUTOPILOT_MIN_MANUAL_SENDS = 30;
const AUTOPILOT_MIN_SIMULATION_DAYS = 7;
const AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

type AutopilotReadinessCheck = { key: string; label: string; ok: boolean; detail: string };
export type AutopilotReadiness = { ready: boolean; checks: AutopilotReadinessCheck[] };

export type AutopilotReadinessInput = {
  settings: AutopilotSettings;
  stats: AutopilotStats;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  roundtripVerifiedAt: string | null;
  actingAdminIsAdmin: boolean;
  privacyVersion: string;
  /** Domaines Resend vérifiés (noms) ; `null` : liste illisible, donc non vérifiable. */
  verifiedResendDomains: ReadonlySet<string> | null;
};

/** Compare deux versions `AAAA-MM-JJ.n` (ordre lexicographique, `n` numérique). */
export function privacyVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => {
    const [date = "", revision = "0"] = value.split(".");
    return { date, revision: Number(revision) };
  };
  const a = parse(version);
  const b = parse(minimum);
  return a.date > b.date || (a.date === b.date && a.revision >= b.revision);
}

function domainOfFrom(from: string | undefined): string | null {
  const match = from?.match(/@([^>\s]+)>?\s*$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Contrôle de préparation : toutes ces conditions doivent être vraies pour passer en mode réel (et à chaque
 * passage en mode réel). Fonction pure, testée sans réseau.
 */
export function evaluateAutopilotReadiness(input: AutopilotReadinessInput): AutopilotReadiness {
  const { settings, stats, env, now } = input;
  const check = (key: string, label: string, ok: boolean, detail: string) => ({
    key,
    label,
    ok,
    detail,
  });
  const checks: AutopilotReadinessCheck[] = [];

  const outbound = env.INFORMATION_AGENT_OUTBOUND_ENABLED === "true";
  const canaryOff = env.INFORMATION_AGENT_OUTBOUND_CANARY_ONLY === "false";
  checks.push(
    check(
      "outbound_env",
      "Envoi activé dans l’environnement, canari coupé",
      outbound && canaryOff,
      outbound && canaryOff
        ? "INFORMATION_AGENT_OUTBOUND_ENABLED=true et canari coupé."
        : "INFORMATION_AGENT_OUTBOUND_ENABLED doit valoir true et INFORMATION_AGENT_OUTBOUND_CANARY_ONLY false.",
    ),
  );

  let controllerOk = true;
  try {
    assertInformationAgentControllerIdentity(env);
  } catch {
    controllerOk = false;
  }
  const secretsOk =
    Boolean(informationAgentPortalSecret(env)) &&
    Boolean(env.RESEND_API_KEY?.trim()) &&
    Boolean(env.RESEND_WEBHOOK_SECRET?.trim()) &&
    controllerOk;
  checks.push(
    check(
      "secrets",
      "Secrets et identité du responsable de traitement",
      secretsOk,
      secretsOk
        ? "Secret du portail (32 octets), clé Resend, secret du webhook et identité présents."
        : "Secret du portail (32 octets), clé Resend, secret du webhook ou identité du responsable manquant.",
    ),
  );

  const inbound = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase() ?? "";
  const fromDomain = domainOfFrom(env.INFORMATION_AGENT_EMAIL_FROM?.trim());
  const fromOk = Boolean(
    fromDomain && inbound && (fromDomain === inbound || fromDomain.endsWith(`.${inbound}`)),
  );
  checks.push(
    check(
      "from_domain",
      "Expéditeur sur le domaine d’envoi et de réception",
      fromOk,
      fromOk
        ? "L’expéditeur est sur le domaine de réception."
        : "INFORMATION_AGENT_EMAIL_FROM doit être une adresse du domaine INFORMATION_AGENT_INBOUND_DOMAIN.",
    ),
  );

  const resendOk = Boolean(
    input.verifiedResendDomains && fromDomain && input.verifiedResendDomains.has(fromDomain),
  );
  checks.push(
    check(
      "resend_domain",
      "Domaine Resend vérifié (envoi et réception)",
      resendOk,
      input.verifiedResendDomains === null
        ? "Liste des domaines Resend illisible : non vérifiable."
        : resendOk
          ? "Domaine vérifié chez Resend."
          : "Le domaine de l’expéditeur n’est pas vérifié chez Resend.",
    ),
  );

  const roundtrip = input.roundtripVerifiedAt ? Date.parse(input.roundtripVerifiedAt) : NaN;
  const roundtripAge = Number.isFinite(roundtrip) ? (now.getTime() - roundtrip) / DAY_MS : Infinity;
  checks.push(
    check(
      "roundtrip",
      "Aller-retour de réception attesté depuis moins de 30 jours",
      roundtripAge < AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS,
      Number.isFinite(roundtripAge)
        ? `Vérifié il y a ${Math.floor(roundtripAge)} jour(s).`
        : "Jamais vérifié.",
    ),
  );

  const privacyOk = privacyVersionAtLeast(
    input.privacyVersion,
    AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION,
  );
  checks.push(
    check(
      "privacy_version",
      "Politique de confidentialité à la version minimale requise",
      privacyOk,
      privacyOk
        ? `Version ${input.privacyVersion}.`
        : `Version publiée ${input.privacyVersion}, version minimale requise ${AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION} (textes du lot 3 non publiés).`,
    ),
  );

  checks.push(
    check(
      "live_allowed",
      "Mode réel autorisé par la migration du lot 3",
      settings.liveAllowed,
      settings.liveAllowed
        ? "Verrou levé."
        : "Verrou du lot 3 en place : seule une migration du lot 3 (textes juridiques publiés) le lève.",
    ),
  );

  checks.push(
    check(
      "aipd",
      "AIPD attestée",
      Boolean(settings.aipdAttestedAt && settings.aipdVersion),
      settings.aipdAttestedAt ? `Version ${settings.aipdVersion}.` : "Aucune attestation d’AIPD.",
    ),
  );

  const manualRate =
    stats.manualRealSends > 0 ? stats.manualPermanentBounces / stats.manualRealSends : 0;
  const manualOk =
    stats.manualRealSends >= AUTOPILOT_MIN_MANUAL_SENDS &&
    stats.manualComplaints === 0 &&
    manualRate < 0.03;
  checks.push(
    check(
      "manual_sends",
      "Au moins 30 envois manuels réels, taux propres",
      manualOk,
      `${stats.manualRealSends} envoi(s) manuel(s) réel(s), ${stats.manualComplaints} plainte(s), ${stats.manualPermanentBounces} rebond(s) définitif(s).`,
    ),
  );

  const started = settings.simulationStartedAt ? Date.parse(settings.simulationStartedAt) : NaN;
  const simulationDays = Number.isFinite(started) ? (now.getTime() - started) / DAY_MS : 0;
  const simulationOk =
    simulationDays >= AUTOPILOT_MIN_SIMULATION_DAYS && stats.anomaliesSinceSimulation === 0;
  checks.push(
    check(
      "simulation",
      "Au moins 7 jours de simulation sans anomalie",
      simulationOk,
      `${Math.floor(simulationDays)} jour(s) de simulation, ${stats.anomaliesSinceSimulation} anomalie(s).`,
    ),
  );

  const blocked = stats.stuckSending + stats.unverifiedOpen;
  checks.push(
    check(
      "no_blocked_mission",
      "Aucune mission bloquée ni envoi à vérifier",
      blocked === 0,
      blocked === 0 ? "Aucune." : `${blocked} mission(s) bloquée(s) ou à vérifier.`,
    ),
  );

  checks.push(
    check(
      "acting_admin",
      "Administrateur d’exécution toujours administrateur",
      Boolean(settings.actingAdminId) && input.actingAdminIsAdmin,
      input.actingAdminIsAdmin
        ? "Oui."
        : "Le compte d’exécution n’est plus administrateur (ou n’est pas choisi).",
    ),
  );

  return { ready: checks.every((entry) => entry.ok), checks };
}

/** Domaines vérifiés chez Resend (`GET /domains`), `null` si la liste est illisible. Aucune écriture. */
export async function loadVerifiedResendDomains(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlySet<string> | null> {
  if (!apiKey) return null;
  try {
    const response = await fetchImpl("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: Array<{
        name?: string;
        status?: string;
        capabilities?: { sending?: string; receiving?: string };
      }>;
    };
    return new Set(
      (body.data ?? [])
        .filter(
          (domain) =>
            domain.status === "verified" &&
            domain.capabilities?.sending === "enabled" &&
            domain.capabilities?.receiving === "enabled",
        )
        .flatMap((domain) => (domain.name ? [domain.name.toLowerCase()] : [])),
    );
  } catch {
    return null;
  }
}

export async function loadRoundtripVerifiedAt(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_operations")
    .select("inbound_roundtrip_verified_at")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  return data?.inbound_roundtrip_verified_at ?? null;
}

/**
 * Le compte est-il toujours un administrateur actif ? Rôle `admin` au profil ET compte ni supprimé ni suspendu
 * (`banned_until`). Une lecture impossible vaut « non » : le pilote s'arrête plutôt que d'agir sous une
 * identité dont l'état est inconnu.
 */
export async function isActiveAdmin(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data?.user_role !== "admin") return false;
  const account = await supabaseAdmin.auth.admin.getUserById(userId);
  const user = account.data?.user;
  if (account.error || !user) return false;
  const bannedUntil = (user as { banned_until?: string | null }).banned_until;
  const deletedAt = (user as { deleted_at?: string | null }).deleted_at;
  return !deletedAt && !(bannedUntil && Date.parse(bannedUntil) > Date.now());
}

export function currentPrivacyVersion(): string {
  return LEGAL_DOCUMENTS.privacy.version;
}
