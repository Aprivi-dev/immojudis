import "server-only";
import { AdminRequiredError, PublicApiError } from "@/lib/api-errors";

/**
 * Refus voulus par les fonctions d'administration de l'agent (paramètre, état), dont le message est
 * écrit pour l'administrateur par la fonction SQL elle-même.
 */
const RPC_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  "22023": 400,
  "55000": 409,
};

/**
 * Erreur d'une RPC d'administration de l'agent (pilote automatique, publication automatique) : un
 * droit refusé devient `AdminRequiredError`, un refus métier voulu par la fonction garde son message ;
 * toute autre erreur de la base reçoit un message neutre (le détail reste dans `cause` et le journal).
 */
export function adminInformationAgentRpcFailure(
  scope: string,
  error: { code?: string; message?: string },
): Error {
  if (error.code === "42501") return new AdminRequiredError();
  const status = error.code ? RPC_REFUSAL_STATUS[error.code] : undefined;
  if (status) {
    return new PublicApiError(error.message ?? "Action refusée.", status, { cause: error });
  }
  console.error(JSON.stringify({ scope, code: error.code ?? null }));
  return new Error("Database call failed", { cause: error });
}
