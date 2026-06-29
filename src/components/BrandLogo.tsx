import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import { cn } from "@/lib/utils";

type BrandMarkVariant = "light" | "dark" | "transparent";

type BrandLogoProps = {
  className?: string;
  markClassName?: string;
  markVariant?: BrandMarkVariant;
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
  variant?: BrandMarkVariant;
}) {
  const toneClass = variant === "dark" ? "text-white" : "text-current";

  return (
    <Landmark
      role="img"
      aria-label="Immojudis"
      className={cn("shrink-0", toneClass, className)}
      strokeWidth={2}
    />
  );
}
