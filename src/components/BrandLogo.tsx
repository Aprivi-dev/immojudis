import { cn } from "@/lib/utils";

const BRAND_MARKS = {
  light: "/brand/immojudis-mark-light.png",
  dark: "/brand/immojudis-mark-dark.png",
  transparent: "/brand/immojudis-mark-transparent.png",
} as const;

type BrandLogoProps = {
  className?: string;
  markClassName?: string;
  markVariant?: keyof typeof BRAND_MARKS;
  textClassName?: string;
  showTagline?: boolean;
};

export function BrandLogo({
  className,
  markClassName,
  markVariant = "transparent",
  textClassName,
  showTagline = false,
}: BrandLogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark
        variant={markVariant}
        className={cn("brand-logo-mark h-8 w-8 shrink-0", markClassName)}
      />
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

export function BrandMark({
  className,
  variant = "light",
}: {
  className?: string;
  variant?: keyof typeof BRAND_MARKS;
}) {
  return (
    <img
      src={BRAND_MARKS[variant]}
      alt="Immojudis"
      className={cn("object-contain", className)}
      width={256}
      height={256}
      decoding="async"
    />
  );
}
