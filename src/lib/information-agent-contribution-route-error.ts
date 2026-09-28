import { NextResponse } from "next/server";
import { z } from "zod";
import { InformationAgentContributionError } from "./information-agent-contribution";

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

export function contributionErrorResponse(error: unknown) {
  const status =
    error instanceof InformationAgentContributionError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : 500;
  const message =
    error instanceof InformationAgentContributionError
      ? error.message
      : status === 400
        ? "Données de dépôt invalides."
        : "Service de dépôt indisponible.";
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
