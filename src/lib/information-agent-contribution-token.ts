import { createHmac, timingSafeEqual } from "node:crypto";

const CONTRIBUTION_TOKEN_VERSION = "v2";
const CONTRIBUTION_TOKEN_LIFETIME_MS = 45 * 24 * 60 * 60 * 1000;

function normalizeRecipientEmail(recipientEmail: string): string {
  return recipientEmail.trim().toLowerCase();
}

function signedPayload(
  missionId: string,
  createdAt: string,
  caseId: string,
  recipientEmail: string,
  contributionTokenVersion: number,
): string {
  return JSON.stringify([
    CONTRIBUTION_TOKEN_VERSION,
    missionId,
    createdAt,
    caseId,
    normalizeRecipientEmail(recipientEmail),
    contributionTokenVersion,
  ]);
}

export function createInformationAgentContributionToken(
  missionId: string,
  createdAt: string,
  caseId: string,
  recipientEmail: string,
  contributionTokenVersion: number,
  secret: string,
): string {
  if (
    !secret ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !caseId ||
    !recipientEmail.trim() ||
    !Number.isSafeInteger(contributionTokenVersion) ||
    contributionTokenVersion < 1
  ) {
    throw new Error("Configuration du lien de dépôt invalide.");
  }
  return createHmac("sha256", secret)
    .update(signedPayload(missionId, createdAt, caseId, recipientEmail, contributionTokenVersion))
    .digest("hex");
}

export function verifyInformationAgentContributionToken({
  missionId,
  createdAt,
  caseId,
  recipientEmail,
  contributionTokenVersion,
  token,
  secret,
  now = Date.now(),
}: {
  missionId: string;
  createdAt: string;
  caseId: string;
  recipientEmail: string;
  contributionTokenVersion: number;
  token: string;
  secret: string;
  now?: number;
}): boolean {
  const created = Date.parse(createdAt);
  if (
    !secret ||
    !Number.isFinite(created) ||
    !Number.isFinite(now) ||
    now < created ||
    now - created > CONTRIBUTION_TOKEN_LIFETIME_MS ||
    !caseId ||
    !recipientEmail.trim() ||
    !Number.isSafeInteger(contributionTokenVersion) ||
    contributionTokenVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return false;
  }
  const expected = createInformationAgentContributionToken(
    missionId,
    createdAt,
    caseId,
    recipientEmail,
    contributionTokenVersion,
    secret,
  );
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}
