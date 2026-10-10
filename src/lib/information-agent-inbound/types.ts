import "server-only";
import type { Database, Json } from "@/integrations/supabase/types";
import { z } from "zod";
import { trimmedStringValue } from "@/lib/guards";

export const INBOUND_ATTACHMENT_LINK_TTL_MS = 55 * 60 * 1000;
export const INBOUND_PROCESSING_VERSION = "inbound-v2";
export const OPEN_INFORMATION_AGENT_CASE_STATUSES = [
  "sending",
  "sent",
  "replied",
  "review",
] as const;

export type SharedCase = Database["public"]["Tables"]["information_agent_cases"]["Row"];
export type Mission = Database["public"]["Tables"]["information_agent_missions"]["Row"];

export type InformationAgentInboundResult = {
  accepted: boolean;
  ignored?: boolean;
  duplicate?: boolean;
  caseId?: string;
  messageId?: string;
  factCount?: number;
  attachmentCount?: number;
  processingStatus?: "completed" | "review" | "ignored" | "queued";
};

export type InboundMessageRef = {
  id: string;
  duplicate: boolean;
  metadata: Json;
};

export type InboundProcessingState = {
  version: string;
  status: "queued" | "processing" | "completed" | "failed" | "review" | "ignored";
  attempts: number;
  providerEmailId: string;
  queuedAt: string;
  leaseId?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  attachmentLinkExpiresAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  reason?: string;
};

export const optionalText = z.unknown().transform((value) => trimmedStringValue(value));
