import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import {
  AUTOPILOT_ART14_LIVE_MAX_DAYS,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import { informationAgentPortalSecret } from "@/lib/information-agent-signed-link";
import { assertInformationAgentControllerIdentity } from "@/lib/information-agent/message-guards";
import { informationAgentOutboundEnabled } from "@/lib/information-agent/config";
import { informationAgentCaseReference } from "@/lib/information-agent/case-reference";
import type { InformationAgentEmailTemplateContent } from "@/lib/information-agent-email-template";
import { getPublishedInformationAgentEmailTemplate } from "@/lib/admin-information-agent-email-template";

/**
 * Version minimale de la politique de confidentialité sans laquelle le mode réel est REFUSÉ : celle qui décrit
 * l'envoi automatique aux avocats, adresses Licitor décodées comprises (accord écrit de Licitor, décision du
 * propriétaire du 23/11/2026 ; la 2026-11-23.1 les excluait). Comparée à la version en vigueur
 * (`LEGAL_DOCUMENTS.privacy.version`) : tant que cette version n'est pas publiée, le mode réel reste impossible.
 */
export const AUTOPILOT_LEGAL_MIN_PRIVACY_VERSION = "2026-11-23.2";

/**
 * Décision du propriétaire du 23/11/2026 : 15 envois manuels, compensés par le plafond de 5 envois par jour en
 * phase 1 et l'arrêt automatique sur rebonds et plaintes.
 *
 * RÈGLES LIÉES : ce seuil, le taux de 3 % de rebonds définitifs, les 7 jours de simulation, la date minimale de
 * l'AIPD et les 30 jours de l'aller-retour sont aussi vérifiés par la porte SQL de
 * `set_information_agent_autopilot_mode` (migration 20261209100300). Les deux changent ensemble.
 */
const AUTOPILOT_MIN_MANUAL_SENDS = 15;
const AUTOPILOT_MIN_SIMULATION_DAYS = 7;
/**
 * AIPD attestée le 23/11/2026 ou après (minuit, heure de Paris) : la version qui couvre l'envoi automatique. Une
 * attestation antérieure portait sur le traitement sans pilote.
 */
export const AUTOPILOT_MIN_AIPD_ATTESTED_AT = "2026-11-22T23:00:00.000Z";
/**
 * Jours de simulation effectifs exigés en plus des 7 jours écoulés : jours avec au moins un envoi simulé par un
 * passage PLANIFIÉ et sans passage en erreur, planifié ou lancé à la main (`cleanSimulationDays`). 5 : les jours
 * ouvrés d'une semaine, seuls jours de passage (lundi au vendredi). Un pilote muet, plafonné ou en erreur ne remplit
 * plus la porte en laissant passer le temps, ni des passages lancés à la main quand la tâche planifiée ne tourne pas.
 */
export const AUTOPILOT_MIN_CLEAN_SIMULATION_DAYS = 5;
const AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS = 30;
/**
 * Au-delà de cet âge, la preuve d'aller-retour approche de son échéance : le pilote ouvre un avertissement
 * d'exploitation (`autopilotRoundtripExpiry`), cinq jours avant que le contrôle `roundtrip` ne bloque le mode réel.
 */
const AUTOPILOT_ROUNDTRIP_WARNING_AGE_DAYS = 25;
const DAY_MS = 86_400_000;

type AutopilotReadinessCheck = { key: string; label: string; ok: boolean; detail: string };

/**
 * Preuve la plus récente de l'aller-retour de réception, calculée par la base à la volée
 * (`public.information_agent_roundtrip_proof`, migration 20261209100300) : l'attestation manuelle (`attestation`) ou
 * une réponse réelle reçue par le webhook, expéditeur authentifié et identique au destinataire, rattachée
 * automatiquement à un dossier envoyé (`reply`, avec ce dossier). Le garde SQL du mode réel lit la même fonction.
 * Jamais d'adresse.
 */
/**
 * Modèle de message figé pour le mode réel (audit du 24/11/2026) : le pilote n'envoie qu'avec le modèle dont
 * l'empreinte (objet et blocs, sans le nom) est inscrite dans `INFORMATION_AGENT_AUTOPILOT_APPROVED_TEMPLATE`. Une
 * nouvelle révision publiée change l'empreinte : le mode réel s'arrête de lui-même (`template_approved`) jusqu'à ce
 * que le propriétaire l'approuve en inscrivant la nouvelle empreinte. L'empreinte porte sur le contenu et non sur le
 * numéro de révision, pour couvrir aussi le modèle du code utilisé en secours.
 */
export function informationAgentTemplateFingerprint(
  content: InformationAgentEmailTemplateContent,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ subjectTemplate: content.subjectTemplate, blocks: content.blocks }))
    .digest("hex")
    .slice(0, 16);
}

export function autopilotTemplateApproved(
  fingerprint: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const approved = env.INFORMATION_AGENT_AUTOPILOT_APPROVED_TEMPLATE?.trim().toLowerCase();
  return Boolean(approved) && approved === fingerprint;
}

export type AutopilotPublishedTemplate = { revision: number; fingerprint: string };

/** Révision et empreinte du modèle que le pilote utiliserait maintenant. Lecture seule. */
export async function loadPublishedTemplateFingerprint(): Promise<AutopilotPublishedTemplate> {
  const template = await getPublishedInformationAgentEmailTemplate();
  return {
    revision: template.revision,
    fingerprint: informationAgentTemplateFingerprint(template.content),
  };
}

export type AutopilotRoundtripProof = {
  provenAt: string;
  source: "attestation" | "reply";
  caseId: string | null;
};
export type AutopilotReadiness = { ready: boolean; checks: AutopilotReadinessCheck[] };

export type AutopilotReadinessInput = {
  settings: AutopilotSettings;
  stats: AutopilotStats;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  roundtripProof: AutopilotRoundtripProof | null;
  /** Nul : état du compte illisible pour le moment (panne passagère) ; le contrôle n'est pas satisfait. */
  actingAdminIsAdmin: boolean | null;
  privacyVersion: string;
  /** Domaines Resend vérifiés (noms) ; `null` : liste illisible, donc non vérifiable. */
  verifiedResendDomains: ReadonlySet<string> | null;
  /** Modèle publié, comparé à l'empreinte approuvée pour l'envoi automatique. */
  publishedTemplate: AutopilotPublishedTemplate;
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

  const outbound = informationAgentOutboundEnabled(env);
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

  const roundtrip = input.roundtripProof ? Date.parse(input.roundtripProof.provenAt) : NaN;
  const roundtripAge = Number.isFinite(roundtrip) ? (now.getTime() - roundtrip) / DAY_MS : Infinity;
  checks.push(
    check(
      "roundtrip",
      "Aller-retour de réception prouvé depuis moins de 30 jours",
      roundtripAge < AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS,
      input.roundtripProof && Number.isFinite(roundtripAge)
        ? `Prouvé il y a ${Math.floor(roundtripAge)} jour(s) par ${describeRoundtripProof(input.roundtripProof)}.`
        : "Jamais prouvé : ni attestation, ni réponse réelle authentifiée rattachée à son dossier.",
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

  const art14Ok =
    settings.art14RuleEnabled && settings.art14MaxAgeDays <= AUTOPILOT_ART14_LIVE_MAX_DAYS;
  checks.push(
    check(
      "art14_live",
      `Règle de l’article 14 active, délai de ${AUTOPILOT_ART14_LIVE_MAX_DAYS} jours au plus`,
      art14Ok,
      art14Ok
        ? `Délai de ${settings.art14MaxAgeDays} jour(s).`
        : `Délai réglé à ${settings.art14MaxAgeDays} jour(s) : ramenez-le à ${AUTOPILOT_ART14_LIVE_MAX_DAYS} jours au plus avant le mode réel.`,
    ),
  );

  const aipdAt = settings.aipdAttestedAt ? Date.parse(settings.aipdAttestedAt) : NaN;
  const aipdRecent = aipdAt >= Date.parse(AUTOPILOT_MIN_AIPD_ATTESTED_AT);
  checks.push(
    check(
      "aipd",
      "AIPD attestée le 23/11/2026 ou après",
      Boolean(settings.aipdAttestedAt && settings.aipdVersion) && aipdRecent,
      !settings.aipdAttestedAt
        ? "Aucune attestation d’AIPD."
        : aipdRecent
          ? `Version ${settings.aipdVersion}.`
          : `Version ${settings.aipdVersion}, attestée avant le 23/11/2026 : attestez la version qui couvre l’envoi automatique.`,
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
      `Au moins ${AUTOPILOT_MIN_MANUAL_SENDS} envois manuels réels, taux propres`,
      manualOk,
      `${stats.manualRealSends} envoi(s) manuel(s) réel(s), ${stats.manualComplaints} plainte(s), ${stats.manualPermanentBounces} rebond(s) définitif(s).`,
    ),
  );

  const started = settings.simulationStartedAt ? Date.parse(settings.simulationStartedAt) : NaN;
  const simulationDays = Number.isFinite(started) ? (now.getTime() - started) / DAY_MS : 0;
  const simulationOk =
    simulationDays >= AUTOPILOT_MIN_SIMULATION_DAYS &&
    stats.cleanSimulationDays >= AUTOPILOT_MIN_CLEAN_SIMULATION_DAYS &&
    stats.anomaliesSinceSimulation === 0;
  checks.push(
    check(
      "simulation",
      "Au moins 7 jours de simulation, dont 5 jours effectifs, sans anomalie",
      simulationOk,
      `${Math.floor(simulationDays)} jour(s) de simulation, ${stats.cleanSimulationDays} jour(s) effectif(s) (envoi simulé, aucun passage en erreur), ${stats.anomaliesSinceSimulation} anomalie(s).`,
    ),
  );

  const templateOk = autopilotTemplateApproved(input.publishedTemplate.fingerprint, env);
  checks.push(
    check(
      "template_approved",
      "Modèle de message approuvé pour l’envoi automatique",
      templateOk,
      templateOk
        ? `Révision ${input.publishedTemplate.revision} approuvée (empreinte ${input.publishedTemplate.fingerprint}).`
        : `Révision ${input.publishedTemplate.revision} publiée, empreinte ${input.publishedTemplate.fingerprint} non approuvée : après relecture, inscrire cette empreinte dans INFORMATION_AGENT_AUTOPILOT_APPROVED_TEMPLATE et redéployer.`,
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
      Boolean(settings.actingAdminId) && input.actingAdminIsAdmin === true,
      input.actingAdminIsAdmin === null
        ? "Lecture impossible pour le moment (panne passagère) : réessayer."
        : input.actingAdminIsAdmin
          ? "Oui."
          : "Le compte d’exécution n’est plus administrateur (ou n’est pas choisi).",
    ),
  );

  return { ready: checks.every((entry) => entry.ok), checks };
}

/** Preuve retenue, pour l'écran et le journal : sa nature et, pour une réponse, la référence du dossier. */
export function describeRoundtripProof(proof: AutopilotRoundtripProof): string {
  return proof.source === "reply" && proof.caseId
    ? `une réponse réelle authentifiée, rattachée au dossier ${informationAgentCaseReference(proof.caseId)} (${proof.caseId})`
    : "l’attestation manuelle";
}

/**
 * Échéance de la preuve d'aller-retour la plus récente (attestation ou réponse réelle) : `expiring` au-delà de
 * 25 jours, `expired` à 30 jours (le contrôle `roundtrip` bloque alors le mode réel), `valid` avant, `unverified`
 * sans preuve lisible. Fonction pure.
 */
export type AutopilotRoundtripExpiry = {
  state: "unverified" | "valid" | "expiring" | "expired";
  ageDays: number | null;
  expiresAt: string | null;
};

export function autopilotRoundtripExpiry(
  proof: AutopilotRoundtripProof | null,
  now: Date,
): AutopilotRoundtripExpiry {
  const verified = proof ? Date.parse(proof.provenAt) : NaN;
  if (!Number.isFinite(verified)) return { state: "unverified", ageDays: null, expiresAt: null };
  const age = (now.getTime() - verified) / DAY_MS;
  return {
    state:
      age >= AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS
        ? "expired"
        : age > AUTOPILOT_ROUNDTRIP_WARNING_AGE_DAYS
          ? "expiring"
          : "valid",
    ageDays: Math.floor(age),
    expiresAt: new Date(verified + AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS * DAY_MS).toISOString(),
  };
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

/** Preuve d'aller-retour la plus récente (`AutopilotRoundtripProof`), ou null. Lecture seule ; une erreur remonte. */
export async function loadRoundtripProof(
  now = new Date(),
): Promise<AutopilotRoundtripProof | null> {
  const { data, error } = await supabaseAdmin.rpc("information_agent_roundtrip_proof", {
    p_now: now.toISOString(),
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row?.proven_at || (row.source !== "attestation" && row.source !== "reply")) return null;
  return { provenAt: row.proven_at, source: row.source, caseId: row.case_id ?? null };
}

/** Réponse de l'API Auth pour un compte qui n'existe pas (et non une panne). */
function isAuthUserNotFound(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 404 || code === "user_not_found";
}

/**
 * Le compte est-il toujours un administrateur actif ? Rôle `admin` au profil ET compte ni supprimé ni suspendu
 * (`banned_until`). Un compte réellement introuvable vaut « non » (le pilote s'arrête). Une lecture impossible
 * (base, panne passagère de l'API Auth) n'est pas une réponse : l'erreur remonte, le passage échoue sans rien
 * faire ni s'arrêter, et le suivant relit l'état (T7, 14/11/2026).
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
  if (account.error) {
    if (isAuthUserNotFound(account.error)) return false;
    throw account.error;
  }
  const user = account.data?.user;
  if (!user) return false;
  const bannedUntil = (user as { banned_until?: string | null }).banned_until;
  const deletedAt = (user as { deleted_at?: string | null }).deleted_at;
  return !deletedAt && !(bannedUntil && Date.parse(bannedUntil) > Date.now());
}

export function currentPrivacyVersion(): string {
  return LEGAL_DOCUMENTS.privacy.version;
}
