import { z } from "zod";
import { renderInformationRequestEmail } from "../../emails/information-request";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  INFORMATION_AGENT_EMAIL_VARIABLES,
  INFORMATION_AGENT_PROTECTED_EMAIL_BLOCKS,
  informationAgentEmailTemplateContentSchema,
  parseInformationAgentEmailTemplateContent,
  renderInformationAgentEmailContent,
  type InformationAgentEmailTemplateContent,
  type InformationAgentEmailTemplateSummary,
  type InformationAgentEmailTemplateWorkspace,
} from "@/lib/information-agent-email-template";

type TemplateRow = Database["public"]["Tables"]["information_agent_email_templates"]["Row"];

export const adminInformationAgentEmailTemplateActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("preview"),
    template: informationAgentEmailTemplateContentSchema,
  }),
  z.object({
    action: z.literal("save_draft"),
    draftId: z.string().uuid().nullable().optional(),
    template: informationAgentEmailTemplateContentSchema,
  }),
  z.object({
    action: z.literal("publish"),
    draftId: z.string().uuid(),
    publicationConfirmed: z.literal(true),
  }),
]);

export type AdminInformationAgentEmailTemplateAction = z.output<
  typeof adminInformationAgentEmailTemplateActionSchema
>;

export async function getAdminInformationAgentEmailTemplateWorkspace(
  authToken: string,
): Promise<InformationAgentEmailTemplateWorkspace> {
  await requireAdmin(authToken);
  const { data, error } = await supabaseAdmin
    .from("information_agent_email_templates")
    .select("*")
    .order("revision", { ascending: false })
    .limit(20);
  if (error) throw error;
  const templates = (data ?? []).map(templateSummaryFromRow);
  const published = templates.find((template) => template.status === "published");
  if (!published) throw new Error("Aucun template d’email publié.");

  return {
    published,
    draft: templates.find((template) => template.status === "draft") ?? null,
    history: templates.filter((template) => template.status !== "draft"),
    variables: INFORMATION_AGENT_EMAIL_VARIABLES,
    protectedBlocks: INFORMATION_AGENT_PROTECTED_EMAIL_BLOCKS.map((block) => ({ ...block })),
  };
}

export async function runAdminInformationAgentEmailTemplateAction({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminInformationAgentEmailTemplateAction;
}) {
  const auth = await requireAdmin(authToken);
  if (input.action === "preview") {
    return previewTemplate(input.template);
  }
  if (input.action === "save_draft") {
    await saveDraft({
      adminId: auth.userId,
      draftId: input.draftId ?? null,
      template: input.template,
    });
  } else {
    await publishDraft({ adminId: auth.userId, draftId: input.draftId });
  }
  return getAdminInformationAgentEmailTemplateWorkspace(authToken);
}

export async function getPublishedInformationAgentEmailTemplate(): Promise<{
  id: string | null;
  revision: number;
  content: InformationAgentEmailTemplateContent;
}> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_email_templates")
    .select("id,revision,name,subject_template,blocks")
    .eq("status", "published")
    .maybeSingle();
  if (error || !data) {
    console.warn(
      `[Information agent] Published email content template unavailable; using code fallback${
        error ? ` (${error.message})` : ""
      }.`,
    );
    return {
      id: null,
      revision: 1,
      content: structuredClone(DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE),
    };
  }
  return {
    id: data.id,
    revision: Number(data.revision),
    content: parseInformationAgentEmailTemplateContent({
      name: data.name,
      subjectTemplate: data.subject_template,
      blocks: data.blocks,
    }),
  };
}

async function saveDraft({
  adminId,
  draftId,
  template,
}: {
  adminId: string;
  draftId: string | null;
  template: InformationAgentEmailTemplateContent;
}) {
  const parsed = informationAgentEmailTemplateContentSchema.parse(template);
  const values = {
    name: parsed.name,
    subject_template: parsed.subjectTemplate,
    blocks: parsed.blocks as unknown as Json,
    updated_by: adminId,
  };

  if (draftId) {
    const { data, error } = await supabaseAdmin
      .from("information_agent_email_templates")
      .update(values)
      .eq("id", draftId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Ce brouillon n’est plus modifiable. Rechargez la page.");
    return;
  }

  const { error } = await supabaseAdmin.from("information_agent_email_templates").insert({
    ...values,
    status: "draft",
    created_by: adminId,
  });
  if (error) throw error;
}

async function publishDraft({ adminId, draftId }: { adminId: string; draftId: string }) {
  const { data: draft, error: draftError } = await supabaseAdmin
    .from("information_agent_email_templates")
    .select("name,subject_template,blocks,status")
    .eq("id", draftId)
    .single();
  if (draftError) throw draftError;
  if (draft.status !== "draft") throw new Error("Ce template n’est plus un brouillon.");
  parseInformationAgentEmailTemplateContent({
    name: draft.name,
    subjectTemplate: draft.subject_template,
    blocks: draft.blocks,
  });

  const { error } = await supabaseAdmin.rpc("publish_information_agent_email_template", {
    p_admin_id: adminId,
    p_template_id: draftId,
  });
  if (error) throw error;
}

async function previewTemplate(template: InformationAgentEmailTemplateContent) {
  const renderedContent = renderInformationAgentEmailContent({
    template,
    values: Object.fromEntries(
      INFORMATION_AGENT_EMAIL_VARIABLES.map((variable) => [variable.key, variable.example]),
    ) as Record<(typeof INFORMATION_AGENT_EMAIL_VARIABLES)[number]["key"], string>,
  });
  const renderedEmail = await renderInformationRequestEmail({
    subject: renderedContent.subject,
    bodyText: renderedContent.bodyText,
    replyTo: "enquete+exemple@reponses.immojudis.com",
    caseReference: "IJ-EXEMPLE",
    appUrl: "https://immojudis.com",
  });
  return {
    preview: {
      subject: renderedContent.subject,
      bodyText: renderedContent.bodyText,
      html: renderedEmail.html,
      text: renderedEmail.text,
    },
  };
}

function templateSummaryFromRow(row: TemplateRow): InformationAgentEmailTemplateSummary {
  const content = parseInformationAgentEmailTemplateContent({
    name: row.name,
    subjectTemplate: row.subject_template,
    blocks: row.blocks,
  });
  return {
    id: row.id,
    revision: Number(row.revision),
    status: row.status,
    ...content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}
