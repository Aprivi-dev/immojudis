import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RateLimitError } from "@/lib/api-errors";
import { informationAgentWithdrawalDueAt } from "@/lib/admin-information-agent-withdrawals";
import {
  INFORMATION_AGENT_STRUCTURE_OBJECTION_SCOPE_STATEMENT,
  formatInformationAgentOriginDate,
} from "@/lib/information-agent-compliance";
import { informationAgentOppositionCoversStructure } from "@/lib/information-agent/contacts";
import { informationAgentPage } from "@/lib/information-agent-public-page";
import { logInformationAgentRouteError } from "@/lib/information-agent-route-log";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  informationAgentRightsPath,
  verifiedSignedEmailLink,
} from "@/lib/information-agent-signed-link";

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
    const verified = verifiedSignedEmailLink(request);
    if (!verified) return invalidLink();
    const action = new URL(request.url);
    const structure = await oppositionCoversStructure(verified.email, "GET");
    return informationAgentPage({
      title: "Ne plus être contacté",
      message: `Confirmez que l’adresse ${verified.email} ne doit plus recevoir de message d’Immojudis.${
        structure ? ` ${INFORMATION_AGENT_STRUCTURE_OBJECTION_SCOPE_STATEMENT}` : ""
      }`,
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
    const verified = verifiedSignedEmailLink(request);
    if (!verified) return invalidLink();
    // Lu avant l'écriture : la page reste exacte même si la ligne du registre change avec l'opposition.
    const structure = await oppositionCoversStructure(verified.email, "POST");
    const opposedAt = new Date();
    const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(
      {
        sale_id: null,
        scope_sale_id: null,
        email: verified.email,
        opposition_status: "opposed",
        opposed_at: opposedAt.toISOString(),
      },
      { onConflict: "scope_sale_id,normalized_email" },
    );
    if (error) throw error;
    // Même date que la tâche « Retraits à faire » de l'onglet Réponses (délai interne de 28 jours).
    const withdrawnBy = formatInformationAgentOriginDate(
      informationAgentWithdrawalDueAt(opposedAt),
    );
    return informationAgentPage({
      title: "Opposition enregistrée",
      message: `${
        structure
          ? "Votre adresse, votre identité professionnelle et les autres adresses de votre étude, de votre cabinet ou de votre service ne seront plus contactées par Immojudis."
          : "Votre adresse et votre identité professionnelle ne seront plus contactées par Immojudis."
      } Les informations que vous nous aviez transmises seront retirées de nos fiches au plus tard le ${withdrawnBy}. Vous pouvez exercer vos autres droits depuis la page Confidentialité.`,
      status: 200,
      links: [
        {
          href: informationAgentRightsPath(verified.email),
          label: "Obtenir une copie de vos données ou demander leur effacement",
        },
      ],
    });
  } catch (error) {
    return failure(error, "POST");
  }
}

/**
 * L'opposition vaudra-t-elle pour toute la structure ? Lecture d'INFORMATION seulement : elle ne doit jamais
 * empêcher d'afficher la page ni d'enregistrer l'opposition. En cas d'échec, l'erreur est journalisée (sans
 * adresse) et la page garde son texte ordinaire, qui reste vrai : l'adresse ne sera plus contactée.
 */
async function oppositionCoversStructure(email: string, method: "GET" | "POST"): Promise<boolean> {
  try {
    return await informationAgentOppositionCoversStructure(email);
  } catch (error) {
    logInformationAgentRouteError("information-agent.opt-out", error, {
      method,
      step: "structure_scope",
    });
    return false;
  }
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
