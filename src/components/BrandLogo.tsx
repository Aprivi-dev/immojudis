import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  markClassName?: string;
  textClassName?: string;
  showTagline?: boolean;
};

export function BrandLogo({
  className,
  markClassName,
  textClassName,
  showTagline = false,
}: BrandLogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark className={cn("brand-logo-mark h-8 w-8 shrink-0", markClassName)} />
      <span className="min-w-0">
        <span
          className={cn(
            "brand-logo-text block text-base font-bold uppercase leading-none text-foreground",
            textClassName,
          )}
        >
          Immojudis
        </span>
        {showTagline ? (
          <span className="mt-1 block text-xs font-medium leading-tight text-[var(--gold)]">
            Ventes aux enchères immobilières judiciaires
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Immojudis"
      className={cn("text-foreground", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Maison + bouclier : contour adaptatif (currentColor) lisible sur tout fond. */}
      <g stroke="currentColor" strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round">
        {/* Toit */}
        <path d="M11.5 26.5 L32 10.5 L52.5 26.5" />
        {/* Cheminée */}
        <path d="M46 21.4 L46 13.5" />
        {/* Flanc gauche du bouclier */}
        <path d="M16 30 V40 C16 49 22 54.2 32 56" />
        {/* Flanc droit du bouclier */}
        <path d="M48 30 V40 C48 49 42 54.2 32 56" />
      </g>

      {/* Marteau de justice : accent doré, point focal de la marque.
          Légèrement réduit pour respirer dans la maison. */}
      <g transform="translate(33 28) scale(0.93) translate(-33 -28)">
        {/* Manche ↙ (part vers le bas-gauche) — dessiné en premier, sous la tête. */}
        <g transform="rotate(34 33 27)">
          <rect x="30.5" y="27" width="5" height="23" rx="2.5" fill="var(--gold)" />
        </g>
        {/* Tête ↗ (haut-droite) + anneaux */}
        <g transform="rotate(-34 33 27)">
          <rect x="21.5" y="21.5" width="23" height="11" rx="5.5" fill="var(--gold)" />
          <line
            x1="26"
            y1="20.5"
            x2="26"
            y2="33.5"
            stroke="var(--background)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <line
            x1="40"
            y1="20.5"
            x2="40"
            y2="33.5"
            stroke="var(--background)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      </g>
    </svg>
  );
}
