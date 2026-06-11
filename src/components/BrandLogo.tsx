import { useId } from "react";
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
  const gradientId = `ijMarkBg-${useId().replaceAll(":", "")}`;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Immojudis"
      className={cn("text-gold", className)}
      fill="none"
    >
      <rect
        x="7"
        y="7"
        width="50"
        height="50"
        rx="16"
        fill={`url(#${gradientId})`}
        stroke="currentColor"
        strokeOpacity="0.42"
      />
      <path d="M19 44V20" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path
        d="M31 20h13v16c0 6.1-4.3 10-10.2 10-3.4 0-6.6-1.4-8.8-4"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M49 15l-4.2 4.2M53 26h-6M49 49l-4.2-4.2"
        stroke="#F8E5C9"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.76"
      />
      <circle cx="19" cy="14" r="2.2" fill="#F8E5C9" opacity="0.9" />
      <defs>
        <linearGradient
          id={gradientId}
          x1="10"
          y1="9"
          x2="56"
          y2="58"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1B1712" />
          <stop offset="0.48" stopColor="#09090B" />
          <stop offset="1" stopColor="#241A0D" />
        </linearGradient>
      </defs>
    </svg>
  );
}
