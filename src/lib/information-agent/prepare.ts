import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import type { z } from "zod";
import { classifyApiError } from "@/lib/api-observability";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPublishedInformationAgentEmailTemplate } from "@/lib/admin-information-agent-email-template";
import { createAdminInformationAgentDraft } from "@/lib/information-agent/draft";
import { asObject, missionFromRow } from "@/lib/information-agent/mission-store";
import {
  previewAdminInformationAgentMission,
  type InformationAgentPreviewResponse,
} from "@/lib/information-agent/preview";
import type {
  informationAgentCreateSchema,
  InformationAgentAdminResponse,
} from "@/lib/information-agent/schemas";

/**
 * « Préparer » en un clic : crée (ou retrouve) le brouillon ET rend l'aperçu exact dans la même réponse.
 * L'administrateur voit le message tel qu'il partira, les motifs bloquants et l'origine de l'adresse, puis
 * confirme et envoie (`approve_and_send`, inchangé : empreinte d'aperçu, confirmation explicite). Cette
 * étape n'envoie rien.
 *
 * - Un brouillon modifiable de la vente est réutilisé tel quel (jamais écrasé) tant que la révision du
 *   gabarit publié n'a pas changé et que l'administrateur ne demande ni adresse, ni nom, ni questions.
 * - Si l'aperçu ne peut pas être rendu, le brouillon est tout de même rendu : l'administrateur affiche
 *   l'aperçu à la main (`previewError` dit pourquoi).
 */
export type InformationAgentPrepareResponse = InformationAgentAdminResponse & {
  preview: InformationAgentPreviewResponse | null;
  previewError: string | null;
  /** Vrai quand le brouillon existait déjà (aucun nouveau brouillon créé). */
  reused: boolean;
};

export async function prepareAdminInformationAgentDraft({
  auth,
  input,
  env = process.env,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof informationAgentCreateSchema>;
  env?: NodeJS.ProcessEnv;
}): Promise<InformationAgentPrepareResponse> {
  assertAdmin(auth);
  const explicit = Boolean(
    input.recipientEmail || input.recipientName || input.questionKeys?.length,
  );

  let response: InformationAgentAdminResponse | null = null;
  let reused = false;
  if (!explicit) {
    const [template, { data, error }] = await Promise.all([
      getPublishedInformationAgentEmailTemplate(),
      supabaseAdmin
        .from("information_agent_missions")
        .select("*")
        .eq("user_id", auth.userId)
        .eq("sale_id", input.saleId)
        .in("status", ["draft", "failed"])
        .order("created_at", { ascending: false })
        .limit(2),
    ]);
    if (error) throw error;
    const existing = data ?? [];
    const only = existing.length === 1 ? existing[0] : null;
    if (only && asObject(only.metadata).email_content_template_revision === template.revision) {
      response = { ok: true, mission: missionFromRow(only), gaps: [], inventory: [], facts: [] };
      reused = true;
    }
  }
  response ??= await createAdminInformationAgentDraft({ auth, input });

  const { mission } = response;
  try {
    const preview = await previewAdminInformationAgentMission({
      auth,
      env,
      input: {
        missionId: mission.id,
        recipientEmail: mission.recipientEmail,
        recipientName: mission.recipientName,
        subject: mission.subject,
        bodyText: mission.bodyText,
        recipientOriginUrl: null,
      },
    });
    return { ...response, preview, previewError: null, reused };
  } catch (error) {
    return { ...response, preview: null, previewError: previewErrorMessage(error), reused };
  }
}

/**
 * Message d'erreur d'aperçu montré à l'administrateur : les messages métier français passent, tout le reste
 * (erreur de base, contrainte, réseau) devient un message générique. Le détail va au journal serveur, comme
 * pour l'enveloppe des routes admin (`adminRoute`), sans adresse email.
 */
function previewErrorMessage(error: unknown): string {
  const classified = classifyApiError(error, {
    fallbackMessage: "Aperçu indisponible.",
    fallbackStatus: 400,
    exposeBusinessMessages: true,
  });
  const detail = error instanceof Error ? error.message : String(error);
  console[classified.status >= 500 ? "error" : "warn"](
    JSON.stringify({
      scope: "admin.api",
      status: classified.status,
      code: classified.code,
      error: detail.replace(/[^\s<>()"',;]+@[^\s<>()"',;]+/g, "[adresse]"),
    }),
  );
  return classified.message;
}
