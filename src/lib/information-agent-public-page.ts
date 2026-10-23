import { NextResponse } from "next/server";

/** Pages HTML minimales des liens signés de l'agent d'information (opposition, accès, effacement). */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export type InformationAgentPageForm = {
  /** Cible du formulaire (chemin relatif, avec le lien signé). */
  action: string;
  buttons: ReadonlyArray<{ label: string; name?: string; value?: string }>;
};

export type InformationAgentPageOptions = {
  title: string;
  message: string;
  status: number;
  forms?: ReadonlyArray<InformationAgentPageForm>;
  links?: ReadonlyArray<{ href: string; label: string }>;
  headers?: Record<string, string>;
};

const BUTTON_STYLE =
  "background:#172036;color:#fff;border:0;border-radius:8px;padding:14px 18px;font-size:15px;cursor:pointer";

export function informationAgentPage({
  title,
  message,
  status,
  forms = [],
  links = [],
  headers = {},
}: InformationAgentPageOptions) {
  const formHtml = forms
    .map(
      (form) =>
        `<form method="post" action="${escapeHtml(form.action)}" style="margin:20px 0 0">${form.buttons
          .map(
            (button) =>
              `<button type="submit"${button.name ? ` name="${escapeHtml(button.name)}" value="${escapeHtml(button.value ?? "")}"` : ""} style="${BUTTON_STYLE};margin:0 8px 8px 0">${escapeHtml(button.label)}</button>`,
          )
          .join("")}</form>`,
    )
    .join("");
  const linkHtml = links
    .map(
      (link) =>
        `<p style="margin:18px 0 0"><a href="${escapeHtml(link.href)}" style="color:#172036">${escapeHtml(link.label)}</a></p>`,
    )
    .join("");
  return new NextResponse(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} - Immojudis</title></head><body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif"><main style="min-height:100vh;display:grid;place-items:center;padding:24px"><section style="max-width:520px;background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:28px"><h1 style="margin:0 0 10px;font-size:24px">${escapeHtml(title)}</h1><p style="margin:0;color:#4b5563;line-height:1.55">${escapeHtml(message)}</p>${formHtml}${linkHtml}</section></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        ...headers,
      },
    },
  );
}
