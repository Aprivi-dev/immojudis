import "server-only";
import { RateLimitError } from "@/lib/api-errors";
import {
  normalizeOptOutEmail,
  parseOptOutEmail,
  verifyInformationAgentOptOutToken,
} from "@/lib/information-agent-opt-out";
import {
  createProfessionalPrivacyRequest,
  isProfessionalRequestType,
} from "@/lib/information-agent-professional-rights";
import { informationAgentPage } from "@/lib/information-agent-public-page";
import { logInformationAgentRouteError } from "@/lib/information-agent-route-log";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Accès et effacement des données d'un professionnel contacté par l'agent d'information.
 *
 * Le lien est celui de l'opposition (adresse et jeton signé du pied de l'email) : il prouve que
 * le demandeur tient l'adresse. `GET` affiche le choix et n'écrit rien (même raison que pour
 * l'opposition) ; `POST` enregistre une demande de droits, traitée ensuite par un administrateur
 * qui répond à l'adresse elle-même. La demande couvre les messages, dossiers et pièces liés à
 * l'adresse.
 */
export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "information-agent.rights.get",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const verified = verifiedLink(request);
    if (!verified) return invalidLink();
    const action = new URL(request.url);
    const target = `${action.pathname}${action.search}`;
    return informationAgentPage({
      title: "Vos données",
      message: `Demande relative à l’adresse ${verified.email} : messages échangés, dossiers et pièces reçues. Nous répondons à cette adresse dans un délai d’un mois.`,
      status: 200,
      forms: [
        {
          action: target,
          buttons: [
            { label: "Obtenir une copie de mes données", name: "requestType", value: "access" },
            {
              label: "Demander l’effacement de mes données",
              name: "requestType",
              value: "erasure",
            },
          ],
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
      bucketKey: "information-agent.rights.post",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const verified = verifiedLink(request);
    if (!verified) return invalidLink();
    const requestType = await readRequestType(request);
    if (!requestType) {
      return informationAgentPage({
        title: "Demande incomplète",
        message: "Choisissez la copie de vos données ou leur effacement, puis réessayez.",
        status: 400,
      });
    }
    await createProfessionalPrivacyRequest({ email: verified.email, requestType });
    return informationAgentPage({
      title: "Demande enregistrée",
      message:
        requestType === "access"
          ? "Votre demande de copie est enregistrée. La réponse sera envoyée à cette adresse dans un délai d’un mois."
          : "Votre demande d’effacement est enregistrée. Elle sera traitée dans un délai d’un mois et confirmée à cette adresse. Votre adresse restera sur la liste des contacts à ne plus solliciter.",
      status: 200,
    });
  } catch (error) {
    return failure(error, "POST");
  }
}

async function readRequestType(request: Request) {
  try {
    const form = await request.formData();
    const value = form.get("requestType");
    return isProfessionalRequestType(value) ? value : null;
  } catch {
    return null;
  }
}

function verifiedLink(request: Request): { email: string } | null {
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
    message: "Ce lien est incomplet ou n’est plus valide.",
    status: 400,
  });
}

function failure(error: unknown, method: "GET" | "POST") {
  if (error instanceof RateLimitError) {
    return informationAgentPage({
      title: "Trop de demandes",
      message: "Trop de demandes en peu de temps. Réessayez dans quelques instants.",
      status: 429,
      headers: { "retry-after": String(error.retryAfterSeconds) },
    });
  }
  logInformationAgentRouteError("information-agent.rights", error, { method });
  return informationAgentPage({
    title: "Service indisponible",
    message:
      "Votre demande n’a pas pu être enregistrée. Répondez simplement à l’email reçu : elle sera traitée par notre équipe.",
    status: 503,
  });
}
