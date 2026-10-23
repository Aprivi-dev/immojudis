import { NextResponse } from "next/server";
import { z } from "zod";
import { InformationAgentContributionError } from "./information-agent-contribution";
import {
  CONTRIBUTION_FIELD_MESSAGES,
  type ContributionFieldName,
} from "./information-agent-contribution-rules";
import { logInformationAgentRouteError } from "./information-agent-route-log";

const MAX_REQUEST_BYTES = 64 * 1024;

export async function readContributionJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new InformationAgentContributionError("Dépôt trop volumineux.", 413);
  }
  if (!request.body) {
    throw new InformationAgentContributionError("Corps de requête manquant.", 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new InformationAgentContributionError("Dépôt trop volumineux.", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new InformationAgentContributionError("Données de dépôt invalides.", 400);
  }
}

/** Champ du formulaire et message pour la première erreur de validation du schéma. */
export function contributionFieldErrorFromZod(error: z.ZodError): {
  field: ContributionFieldName | null;
  message: string;
} {
  const issue = error.issues[0];
  const root = issue?.path[0];
  const tooBig = issue?.code === "too_big";
  switch (root) {
    case "senderName":
      return {
        field: "senderName",
        message: tooBig
          ? CONTRIBUTION_FIELD_MESSAGES.senderNameTooLong
          : CONTRIBUTION_FIELD_MESSAGES.senderNameMissing,
      };
    case "senderEmail":
      return {
        field: "senderEmail",
        message: tooBig
          ? CONTRIBUTION_FIELD_MESSAGES.senderEmailTooLong
          : CONTRIBUTION_FIELD_MESSAGES.senderEmailInvalid,
      };
    case "note":
      return { field: "note", message: CONTRIBUTION_FIELD_MESSAGES.noteTooLong };
    case "externalLinks":
      return {
        field: "externalLinks",
        message:
          issue && issue.path.length > 1
            ? CONTRIBUTION_FIELD_MESSAGES.linkTooLong
            : CONTRIBUTION_FIELD_MESSAGES.linksTooMany,
      };
    case "authorizedToTransmit":
      return {
        field: "authorizedToTransmit",
        message: CONTRIBUTION_FIELD_MESSAGES.authorizationMissing,
      };
    case "files":
      return {
        field: "files",
        message: "Une pièce jointe n’est plus valide : retirez-la et ajoutez-la de nouveau.",
      };
    default:
      return { field: null, message: CONTRIBUTION_FIELD_MESSAGES.invalidData };
  }
}

/**
 * Réponse d'erreur des routes de dépôt. Une erreur de validation dit quel champ est en cause ;
 * une erreur serveur (500) est journalisée sans donnée personnelle (type et code seulement).
 */
export function contributionErrorResponse(error: unknown, scope = "contribution") {
  let status = 500;
  let message = "Service de dépôt indisponible.";
  let field: ContributionFieldName | null = null;
  if (error instanceof InformationAgentContributionError) {
    status = error.status;
    message = error.message;
    field = error.field ?? null;
  } else if (error instanceof z.ZodError) {
    status = 400;
    ({ field, message } = contributionFieldErrorFromZod(error));
  }
  if (status >= 500) {
    logInformationAgentRouteError(`information-agent.${scope}`, error, { status });
  }
  return NextResponse.json(field ? { error: message, field } : { error: message }, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
