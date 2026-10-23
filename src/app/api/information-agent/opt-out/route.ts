import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RateLimitError } from "@/lib/api-errors";
import {
  normalizeOptOutEmail,
  parseOptOutEmail,
  verifyInformationAgentOptOutToken,
} from "@/lib/information-agent-opt-out";
import { informationAgentPage } from "@/lib/information-agent-public-page";
import { logInformationAgentRouteError } from "@/lib/information-agent-route-log";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Opposition depuis le pied d'un e-mail de l'agent d'information.
 *
 * - `GET` affiche une page de confirmation et n'écrit rien : les passerelles de messagerie qui
 *   ouvrent les liens pour les analyser ne doivent pas désinscrire un destinataire à son insu.
 * - `POST` enregistre l'opposition globale (bouton de la page, ou désinscription en un clic de la
 *   messagerie selon la RFC 8058, en-tête `List-Unsubscribe-Post`). L'agent ne contacte plus jamais
 *   une adresse opposée.
 *
 * Les seaux de débit de `GET` et de `POST` sont séparés : les analyses de liens par les passerelles
 * (GET) ne doivent pas épuiser le quota qui permet d'enregistrer une opposition (POST).
 */
export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "information-agent.opt-out.get",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const verified = verifiedOptOut(request);
    if (!verified) return invalidLink();
    const action = new URL(request.url);
    return informationAgentPage({
      title: "Ne plus être contacté",
      message: `Confirmez que l’adresse ${verified.email} ne doit plus recevoir de message d’Immojudis.`,
      status: 200,
      forms: [
        {
          action: `${action.pathname}${action.search}`,
          buttons: [{ label: "Confirmer : ne plus me contacter" }],
        },
      ],
    });
  } catch (error) {
    return failure(error, "GET");
  }
}

export async function POST(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "information-agent.opt-out.post",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const verified = verifiedOptOut(request);
    if (!verified) return invalidLink();
    const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(
      {
        sale_id: null,
        scope_sale_id: null,
        email: verified.email,
        opposition_status: "opposed",
        opposed_at: new Date().toISOString(),
      },
      { onConflict: "scope_sale_id,normalized_email" },
    );
    if (error) throw error;
    const action = new URL(request.url);
    return informationAgentPage({
      title: "Opposition enregistrée",
      message:
        "Votre adresse et votre identité professionnelle ne seront plus contactées par Immojudis. Vous pouvez exercer vos autres droits depuis la page Confidentialité.",
      status: 200,
      links: [
        {
          href: `/api/information-agent/rights${action.search}`,
          label: "Obtenir une copie de vos données ou demander leur effacement",
        },
      ],
    });
  } catch (error) {
    return failure(error, "POST");
  }
}

function verifiedOptOut(request: Request): { email: string } | null {
  const params = new URL(request.url).searchParams;
  const email = parseOptOutEmail(params.get("e"));
  const secret = process.env.INFORMATION_AGENT_PORTAL_SECRET?.trim() ?? "";
  if (!email || !verifyInformationAgentOptOutToken(email, params.get("t") ?? "", secret)) {
    return null;
  }
  return { email: normalizeOptOutEmail(email) };
}

function invalidLink() {
  return informationAgentPage({
    title: "Lien invalide",
    message: "Ce lien d’opposition est incomplet ou n’est plus valide.",
    status: 400,
  });
}

/** Limite de débit : 429 avec `Retry-After` ; toute autre erreur : 503, journalisée sans donnée personnelle. */
function failure(error: unknown, method: "GET" | "POST") {
  if (error instanceof RateLimitError) {
    return informationAgentPage({
      title: "Trop de demandes",
      message:
        method === "POST"
          ? "Trop de demandes en peu de temps : votre opposition n’a pas encore été enregistrée. Réessayez dans quelques instants."
          : "Trop de demandes en peu de temps. Réessayez dans quelques instants.",
      status: 429,
      headers: { "retry-after": String(error.retryAfterSeconds) },
    });
  }
  logInformationAgentRouteError("information-agent.opt-out", error, { method });
  return informationAgentPage({
    title: "Service indisponible",
    message:
      "Votre demande n’a pas pu être enregistrée. Répondez simplement à l’email reçu : l’opposition sera traitée par notre équipe.",
    status: 503,
  });
}
