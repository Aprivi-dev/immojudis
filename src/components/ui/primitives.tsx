import type { ComponentProps, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Primitives du système visuel Immojudis : Card, Eyebrow, Button, Badge et
 * PageShell. Elles ne portent que des jetons (voir src/styles.css), jamais de
 * couleur codée en dur.
 */

// ── Eyebrow ───────────────────────────────────────────────────────────────

export function Eyebrow({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("text-xs font-semibold uppercase tracking-[0.14em] text-gold-text", className)}
      {...props}
    />
  );
}

// ── Card ──────────────────────────────────────────────────────────────────

type CardProps<T extends ElementType> = {
  as?: T;
  padded?: boolean;
  interactive?: boolean;
} & Omit<ComponentProps<T>, "as">;

export function Card<T extends ElementType = "div">({
  as,
  padded = true,
  interactive = false,
  className,
  ...props
}: CardProps<T>) {
  const Component: ElementType = as ?? "div";
  return (
    <Component
      className={cn(
        "rounded-lg border border-line bg-white text-foreground",
        padded && "p-4 sm:p-5",
        interactive && "transition-colors hover:border-gold",
        className,
      )}
      {...props}
    />
  );
}

// ── Button ────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "dark" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-gold text-brand-navy hover:bg-gold-light",
  secondary: "border border-line bg-white text-brand-navy hover:border-brand-navy",
  dark: "bg-brand-navy text-white hover:bg-brand-navy-soft",
  ghost: "text-brand-navy hover:bg-surface-tint",
  danger: "border border-danger bg-white text-danger hover:bg-danger-tint",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-xs",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-base",
};

/** Classes d'un bouton, utilisables aussi sur un lien (`<Link className={buttonClasses()}>`). */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-tint disabled:text-ink-soft",
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  );
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClasses({ variant, size, className })} {...props} />;
}

// ── Badge ─────────────────────────────────────────────────────────────────

/**
 * Tons des pastilles (docs/design/fondations.md) : la couleur ne marque que ce qui demande
 * l'attention. `neutral` pour une information (type de vente), `danger` pour l'urgent (vente
 * aujourd'hui), `warning` pour ce qui est à surveiller (échéance proche, point à vérifier),
 * `success` pour une donnée confirmée, `info` pour une aide. Deux pastilles au plus par carte, et
 * toujours un libellé : la couleur seule ne porte jamais l'information.
 */
export type BadgeTone = "neutral" | "gold" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-white text-brand-navy",
  gold: "border-gold/40 bg-gold/10 text-gold-text",
  success: "border-success/25 bg-success-tint text-success",
  warning: "border-warning/25 bg-warning-tint text-warning",
  danger: "border-danger/25 bg-danger-tint text-danger",
  info: "border-info/25 bg-info-tint text-info",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: BadgeTone }) {
  // `text-caption` est ajoutée après la fusion : tailwind-merge la prend pour une couleur et la
  // retirerait devant celle du ton (la déclarer dans sa configuration coûte 1 Ko par page).
  return (
    <span
      className={`${cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
        BADGE_TONES[tone],
        className,
      )} text-caption`}
      {...props}
    />
  );
}

// ── PageShell ─────────────────────────────────────────────────────────────

const SHELL_WIDTHS = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  wide: "max-w-6xl",
} as const;

/**
 * Mise en page commune des pages de compte. L'en-tête du site réserve déjà sa
 * hauteur : aucun décalage supérieur codé en dur.
 */
export function PageShell({
  eyebrow,
  title,
  description,
  actions,
  width = "default",
  className,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  width?: keyof typeof SHELL_WIDTHS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main
      id="contenu"
      className={cn("mx-auto w-full px-4 py-8 sm:px-6 sm:py-12", SHELL_WIDTHS[width], className)}
    >
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? <Eyebrow className="mb-2">{eyebrow}</Eyebrow> : null}
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
          {description ? (
            <div className="mt-3 max-w-2xl text-base text-ink-soft">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
    </main>
  );
}
