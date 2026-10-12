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
        "rounded-xl border border-line bg-white text-foreground shadow-sm",
        padded && "p-4 sm:p-5",
        interactive && "transition-shadow hover:border-gold hover:shadow-md",
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
  danger: "border border-red-700 bg-white text-red-700 hover:bg-red-50",
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
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-tint disabled:text-ink-soft",
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

export type BadgeTone = "neutral" | "gold" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-surface-tint text-ink-soft",
  gold: "border-gold/40 bg-gold/10 text-gold-text",
  success: "border-emerald-700/30 bg-emerald-50 text-emerald-800",
  warning: "border-amber-700/30 bg-amber-50 text-amber-900",
  danger: "border-red-700/30 bg-red-50 text-red-800",
  info: "border-sky-700/30 bg-sky-50 text-sky-900",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        BADGE_TONES[tone],
        className,
      )}
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
