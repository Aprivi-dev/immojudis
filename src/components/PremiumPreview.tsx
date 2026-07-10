"use client";

import type { ReactNode } from "react";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router-compat";
import { cn } from "@/lib/utils";

export function PremiumPreview({
  title,
  description,
  children,
  className,
  compact = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <section
      className={cn(
        "relative isolate overflow-hidden rounded-lg border border-border bg-card shadow-sm",
        className,
      )}
      aria-label={`${title} — réservé au plan Analyse`}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none select-none opacity-55 blur-[6px] saturate-50",
          compact ? "p-4" : "p-5 sm:p-6",
        )}
      >
        {children}
      </div>

      <div className="absolute inset-0 grid place-items-center bg-background/42 p-4 backdrop-blur-[1px]">
        <div className="max-w-md rounded-lg border border-border/80 bg-background/94 p-4 text-center shadow-lg">
          <span className="mx-auto grid size-10 place-items-center rounded-full border border-primary/20 bg-primary/10 text-primary">
            <LockKeyhole className="size-5" aria-hidden />
          </span>
          <h2 className="mt-3 text-base font-extrabold text-foreground">{title}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
          <Button asChild size="sm" className="mt-3">
            <Link to="/accompagnement">
              <LockKeyhole data-icon="inline-start" aria-hidden />
              Débloquer pour 29 €
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
