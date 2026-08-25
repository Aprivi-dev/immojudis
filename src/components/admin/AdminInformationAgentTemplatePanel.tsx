import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import {
  fetchAdminInformationAgentEmailTemplate,
  previewAdminInformationAgentEmailTemplate,
  publishAdminInformationAgentEmailTemplateDraft,
  saveAdminInformationAgentEmailTemplateDraft,
} from "@/lib/client-api";
import {
  type InformationAgentEmailBlock,
  type InformationAgentEmailTemplateContent,
  type InformationAgentEmailTemplatePreview,
  type InformationAgentEmailTemplateWorkspace,
  templateVariableToken,
} from "@/lib/information-agent-email-template";

const TEMPLATE_QUERY_KEY = ["admin-information-agent-email-template"] as const;

export function AdminInformationAgentTemplatePanel() {
  const templateQuery = useQuery({
    queryKey: TEMPLATE_QUERY_KEY,
    queryFn: fetchAdminInformationAgentEmailTemplate,
    staleTime: 30_000,
  });

  if (templateQuery.isLoading) {
    return (
      <AdminPanel className="flex min-h-80 items-center justify-center p-6 text-sm text-[#132238]/60">
        <LoadingIndicator />
        Chargement du template
      </AdminPanel>
    );
  }

  if (templateQuery.error || !templateQuery.data) {
    return (
      <AdminPanel className="p-6">
        <p className="text-sm text-red-700">
          {templateQuery.error instanceof Error
            ? templateQuery.error.message
            : "Le template d’email est indisponible."}
        </p>
        <button
          type="button"
          className="admin-button-secondary mt-4"
          onClick={() => void templateQuery.refetch()}
        >
          Réessayer
        </button>
      </AdminPanel>
    );
  }

  const source = templateQuery.data.draft ?? templateQuery.data.published;
  return (
    <InformationAgentTemplateEditor
      key={`${source.id}-${source.updatedAt}`}
      workspace={templateQuery.data}
    />
  );
}

function InformationAgentTemplateEditor({
  workspace,
}: {
  workspace: InformationAgentEmailTemplateWorkspace;
}) {
  const queryClient = useQueryClient();
  const source = workspace.draft ?? workspace.published;
  const [template, setTemplate] = useState<InformationAgentEmailTemplateContent>(() => ({
    name: source.name,
    subjectTemplate: source.subjectTemplate,
    blocks: source.blocks.map((block) => ({ ...block })),
  }));
  const [dirty, setDirty] = useState(false);
  const [publicationConfirmed, setPublicationConfirmed] = useState(false);
  const [preview, setPreview] = useState<InformationAgentEmailTemplatePreview | null>(null);

  const previewMutation = useMutation({
    mutationFn: () => previewAdminInformationAgentEmailTemplate(template),
    onSuccess: (response) => setPreview(response.preview),
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Prévisualisation impossible");
    },
  });
  const saveMutation = useMutation({
    mutationFn: () =>
      saveAdminInformationAgentEmailTemplateDraft({
        draftId: workspace.draft?.id ?? null,
        template,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(TEMPLATE_QUERY_KEY, response);
      setDirty(false);
      setPublicationConfirmed(false);
      toast.success("Brouillon enregistré.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Enregistrement impossible");
    },
  });
  const publishMutation = useMutation({
    mutationFn: () => {
      if (!workspace.draft?.id) throw new Error("Enregistrez d’abord un brouillon.");
      return publishAdminInformationAgentEmailTemplateDraft(workspace.draft.id);
    },
    onSuccess: (response) => {
      queryClient.setQueryData(TEMPLATE_QUERY_KEY, response);
      setPublicationConfirmed(false);
      toast.success("Le nouveau template est publié.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Publication impossible");
    },
  });

  const updateTemplate = (
    updater: (
      current: InformationAgentEmailTemplateContent,
    ) => InformationAgentEmailTemplateContent,
  ) => {
    setTemplate(updater);
    setDirty(true);
    setPublicationConfirmed(false);
  };
  const updateBlock = (blockId: InformationAgentEmailBlock["id"], content: string) => {
    updateTemplate((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.id === blockId ? { ...block, content } : block)),
    }));
  };
  const moveBlock = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= template.blocks.length) return;
    updateTemplate((current) => {
      const blocks = current.blocks.map((block) => ({ ...block }));
      const selected = blocks[index];
      const target = blocks[destination];
      if (!selected || !target) return current;
      blocks[index] = target;
      blocks[destination] = selected;
      return { ...current, blocks };
    });
  };

  return (
    <div className="space-y-4">
      <AdminPanel className="p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#a36f2c]">
              Agent IA autonome
            </div>
            <h2 className="mt-2 text-xl font-semibold text-[#132238]">
              Template de prise de contact
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#132238]/65">
              Les blocs fixes restent identiques pour toutes les annonces. Les blocs dynamiques
              remplacent automatiquement les variables par les données de la vente et les questions
              détectées par l’agent.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <StatusBadge label={`Publié · v${workspace.published.revision}`} tone="green" />
            {workspace.draft ? (
              <StatusBadge label={`Brouillon · v${workspace.draft.revision}`} tone="amber" />
            ) : null}
          </div>
        </div>
      </AdminPanel>

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.08fr)_minmax(30rem,0.92fr)]">
        <div className="space-y-4">
          <AdminPanel className="p-5">
            <AdminSectionHeading
              title="Contenu éditable"
              description="Aucun HTML libre n’est accepté. Les variables autorisées sont échappées au rendu."
            />

            <div className="mt-5 grid gap-4">
              <EditorField label="Nom interne du modèle">
                <input
                  value={template.name}
                  maxLength={120}
                  onChange={(event) =>
                    updateTemplate((current) => ({ ...current, name: event.target.value }))
                  }
                  className="admin-template-input"
                />
              </EditorField>
              <EditorField label="Objet de l’email">
                <input
                  value={template.subjectTemplate}
                  maxLength={200}
                  onChange={(event) =>
                    updateTemplate((current) => ({
                      ...current,
                      subjectTemplate: event.target.value,
                    }))
                  }
                  className="admin-template-input font-mono"
                />
              </EditorField>
            </div>

            <div className="mt-5 rounded-xl border border-[#132238]/10 bg-[#f7f9fc] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#132238]/58">
                Variables autorisées
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {workspace.variables.map((variable) => (
                  <span
                    key={variable.key}
                    title={`${variable.label} · Exemple : ${variable.example}`}
                    className="rounded-md border border-[#132238]/10 bg-white px-2 py-1 font-mono text-[11px] text-[#72501f]"
                  >
                    {templateVariableToken(variable.key)}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {template.blocks.map((block, index) => (
                <article
                  key={block.id}
                  className="rounded-xl border border-[#132238]/10 bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                            block.kind === "dynamic"
                              ? "bg-blue-50 text-blue-700"
                              : "bg-[#f6eedc] text-[#795421]"
                          }`}
                        >
                          Bloc {block.kind === "dynamic" ? "dynamique" : "fixe"}
                        </span>
                        <span className="text-sm font-semibold text-[#132238]">{block.label}</span>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-[#132238]/45">{block.id}</p>
                    </div>
                    <div className="flex gap-1">
                      <OrderButton
                        label="Monter ce bloc"
                        disabled={index === 0}
                        onClick={() => moveBlock(index, -1)}
                      >
                        <span aria-hidden="true">↑</span>
                      </OrderButton>
                      <OrderButton
                        label="Descendre ce bloc"
                        disabled={index === template.blocks.length - 1}
                        onClick={() => moveBlock(index, 1)}
                      >
                        <span aria-hidden="true">↓</span>
                      </OrderButton>
                    </div>
                  </div>
                  <textarea
                    value={block.content}
                    rows={Math.max(3, Math.min(8, block.content.split("\n").length + 2))}
                    maxLength={4000}
                    onChange={(event) => updateBlock(block.id, event.target.value)}
                    className="admin-template-input mt-3 min-h-24 resize-y leading-6"
                    aria-label={`Contenu du bloc ${block.label}`}
                  />
                </article>
              ))}
            </div>

            <div className="mt-5 flex flex-col gap-3 border-t border-[#132238]/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-[#132238]/55">
                {dirty ? "Modifications non enregistrées" : "Brouillon synchronisé"}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="admin-button-secondary"
                  disabled={previewMutation.isPending}
                  onClick={() => previewMutation.mutate()}
                >
                  {previewMutation.isPending ? <LoadingIndicator /> : null}
                  Prévisualiser
                </button>
                <button
                  type="button"
                  className="admin-button-primary"
                  disabled={saveMutation.isPending || !dirty}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? <LoadingIndicator /> : null}
                  Enregistrer le brouillon
                </button>
              </div>
            </div>
          </AdminPanel>

          <AdminPanel className="p-5">
            <AdminSectionHeading
              title="Socle protégé"
              description="Ces mentions réglementaires restent présentes même si le contenu éditable est modifié."
            />
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {workspace.protectedBlocks.map((block) => (
                <div
                  key={block.title}
                  className="rounded-xl border border-emerald-900/10 bg-emerald-50/60 p-4"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
                    {block.title}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-emerald-950/65">{block.description}</p>
                </div>
              ))}
            </div>
          </AdminPanel>
        </div>

        <div className="space-y-4 2xl:sticky 2xl:top-4 2xl:self-start">
          <AdminPanel className="overflow-hidden">
            <div className="border-b border-[#132238]/10 p-5">
              <AdminSectionHeading
                title="Prévisualisation"
                description={
                  preview
                    ? `Objet : ${preview.subject}`
                    : "Lancez une prévisualisation pour contrôler le rendu desktop et le texte final."
                }
              />
            </div>
            {preview ? (
              <iframe
                title="Prévisualisation sécurisée du template d’email"
                srcDoc={preview.html}
                sandbox=""
                className="h-[720px] w-full bg-[#f5f2eb]"
              />
            ) : (
              <div className="grid min-h-[28rem] place-items-center p-8 text-center text-sm text-[#132238]/55">
                <div>
                  <p>Aucun aperçu généré pour ce brouillon.</p>
                </div>
              </div>
            )}
          </AdminPanel>

          <AdminPanel className="p-5">
            <AdminSectionHeading
              title="Publication"
              description="Le template publié sera utilisé uniquement pour les prochaines missions créées."
            />
            <label className="mt-4 flex items-start gap-3 rounded-xl border border-[#132238]/10 bg-[#f7f9fc] p-4 text-sm text-[#132238]/72">
              <input
                type="checkbox"
                checked={publicationConfirmed}
                onChange={(event) => setPublicationConfirmed(event.target.checked)}
                className="mt-0.5 size-4 accent-[#a6792b]"
              />
              <span>J’ai vérifié l’objet, les blocs dynamiques et l’aperçu de l’email.</span>
            </label>
            <button
              type="button"
              className="admin-button-primary mt-3 w-full justify-center"
              disabled={
                publishMutation.isPending ||
                !workspace.draft ||
                dirty ||
                !publicationConfirmed ||
                !preview
              }
              onClick={() => publishMutation.mutate()}
            >
              {publishMutation.isPending ? <LoadingIndicator /> : null}
              Publier ce template
            </button>
            {!workspace.draft ? (
              <p className="mt-2 text-xs text-[#132238]/52">
                Modifiez le contenu puis enregistrez un brouillon avant de publier.
              </p>
            ) : dirty ? (
              <p className="mt-2 text-xs text-amber-700">
                Enregistrez vos dernières modifications avant la publication.
              </p>
            ) : null}
          </AdminPanel>

          <AdminPanel className="p-5">
            <AdminSectionHeading
              title="Historique"
              description="Dernières versions publiées ou archivées"
            />
            <div className="mt-4 divide-y divide-[#132238]/10">
              {workspace.history.slice(0, 8).map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[#132238]">
                      v{entry.revision} · {entry.name}
                    </p>
                    <p className="mt-1 text-xs text-[#132238]/50">
                      {formatDateTime(entry.publishedAt ?? entry.updatedAt)}
                    </p>
                  </div>
                  {entry.status === "published" ? (
                    <span className="shrink-0 text-emerald-600" aria-label="Version publiée">
                      ✓
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[#132238]/45">
                      Archivé
                    </span>
                  )}
                </div>
              ))}
            </div>
          </AdminPanel>
        </div>
      </div>
    </div>
  );
}

function EditorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.13em] text-[#132238]/58">
      {label}
      {children}
    </label>
  );
}

function LoadingIndicator() {
  return (
    <span
      aria-hidden="true"
      className="mr-2 size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

function OrderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md border border-[#132238]/10 text-[#132238]/60 transition hover:bg-[#f4f7fa] disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: "green" | "amber" }) {
  return (
    <span
      className={`rounded-full px-3 py-1.5 font-semibold ${
        tone === "green" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
      }`}
    >
      {label}
    </span>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
