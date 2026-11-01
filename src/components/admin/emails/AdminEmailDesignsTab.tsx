"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import { Pill, queryProblem, toggle } from "@/components/admin/emails/email-ui";
import type { DesignTemplate } from "@/lib/admin-emails/designs";
import { fetchAdminEmailDesigns } from "@/lib/client-api/admin-emails";
import type { EmailSampleVariant } from "@/lib/email-templates/types";
import { toast } from "@/lib/toast";

const VIEWPORTS = [
  [600, "Bureau (600 px)"],
  [375, "Mobile (375 px)"],
] as const;
const MUTED = "text-brand-navy/62";

async function copy(value: string, done: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(done);
  } catch {
    toast.error("Copie impossible.");
  }
}

export function AdminEmailDesignsTab() {
  const [width, setWidth] = useState<number>(600);
  const [dark, setDark] = useState(false);
  const query = useQuery({
    queryKey: ["admin-emails-designs", dark],
    queryFn: () => fetchAdminEmailDesigns(dark),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const problem = queryProblem(query, "Chargement des aperçus…");
  if (problem || !query.data) return problem;

  return (
    <div className="space-y-5">
      <AdminPanel className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Affichage">
          {VIEWPORTS.map(([size, label]) => (
            <button
              key={size}
              type="button"
              aria-pressed={width === size}
              className={toggle(width === size)}
              onClick={() => setWidth(size)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={dark}
            className={toggle(dark)}
            onClick={() => setDark(!dark)}
          >
            Sombre
          </button>
        </div>
        <p className={`text-sm ${MUTED}`}>{query.data.intro}</p>
      </AdminPanel>
      {query.data.templates.map((template) => (
        <TemplateCard key={template.key} template={template} width={width} />
      ))}
    </div>
  );
}

function TemplateCard({ template, width }: { template: DesignTemplate; width: number }) {
  return (
    <AdminPanel className="space-y-4 p-5">
      <AdminSectionHeading title={template.label} description={template.description} />
      <div className="flex flex-wrap gap-2">
        {template.badges.map((badge) => (
          <Pill key={badge.text} tone={badge.tone}>
            {badge.text}
          </Pill>
        ))}
      </div>
      {template.notice ? (
        <p className="rounded-lg border border-warning/30 bg-warning-tint p-3 text-sm">
          {template.notice}
        </p>
      ) : null}
      {template.unavailable ? <p className={`text-sm ${MUTED}`}>{template.unavailable}</p> : null}
      <div className="flex flex-wrap gap-6">
        {template.variants.map((variant) => (
          <Variant key={variant.key} variant={variant} width={width} />
        ))}
      </div>
    </AdminPanel>
  );
}

function Variant({ variant, width }: { variant: EmailSampleVariant; width: number }) {
  const { html, pasteHtml, subject, label } = variant;
  return (
    <figure className="min-w-0 max-w-full space-y-2" style={{ width }}>
      <figcaption className="text-sm">
        <strong>{label}</strong>
        <span className={`block break-words ${MUTED}`}>Objet : {subject}</span>
      </figcaption>
      {html === null ? (
        <pre className="whitespace-pre-wrap break-words rounded-lg border border-brand-navy/10 bg-surface-muted p-3 text-xs">
          {variant.text}
        </pre>
      ) : (
        <iframe
          title={`Aperçu : ${label}`}
          srcDoc={html}
          sandbox=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-[560px] w-full rounded-lg border border-brand-navy/10 bg-surface-muted"
        />
      )}
      {pasteHtml ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="admin-button-secondary"
            onClick={() => void copy(subject, "Objet copié.")}
          >
            Copier l’objet
          </button>
          <button
            type="button"
            className="admin-button-secondary"
            onClick={() => void copy(pasteHtml, "HTML copié.")}
          >
            Copier le HTML
          </button>
        </div>
      ) : null}
    </figure>
  );
}
