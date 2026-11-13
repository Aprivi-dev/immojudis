import type { ReactNode } from "react";

const PILL_TONES = {
  success: "border-success/25 bg-success-tint text-success",
  warning: "border-warning/25 bg-warning-tint text-warning",
  danger: "border-danger/25 bg-danger-tint text-danger",
  info: "border-info/25 bg-info-tint text-info",
  neutral: "border-brand-navy/15 bg-surface-muted text-brand-navy/70",
} as const;

export type AdminPillTone = keyof typeof PILL_TONES;

/**
 * Pastille de statut de l'administration : une seule forme et les mêmes tons pour toutes les vues.
 * Module sans autre dépendance que React : l'onglet des e-mails l'importe sans faire entrer
 * `admin-ui.tsx` en double dans le JavaScript de sa route.
 */
export function AdminPill({
  tone = "neutral",
  children,
}: {
  tone?: AdminPillTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  );
}
