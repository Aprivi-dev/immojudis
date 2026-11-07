import type { AriaRole, ReactNode } from "react";
import { Card, Eyebrow, PageTitle } from "@/components/ui/primitives";

/**
 * Gabarit commun des pages d'état : page introuvable, erreur, lien expiré ou retiré (repasse design
 * n° 37). Une carte centrée : surtitre, titre de page (`PageTitle`), explication, contenu facultatif
 * (recherche…) puis les actions. La page d'erreur globale (`global-error.tsx`), privée de feuille de
 * style, en reprend la même mise en page en styles en ligne.
 */
export function StatusPage({
  eyebrow,
  title,
  description,
  actions,
  role,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  /** Boutons et liens, du principal au secondaire. */
  actions?: ReactNode;
  /** `alert` pour une erreur annoncée dès l'affichage. */
  role?: AriaRole;
  children?: ReactNode;
}) {
  return (
    <main id="contenu" className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6 sm:py-24">
      <Card role={role} className="text-center sm:!p-10">
        <Eyebrow>{eyebrow}</Eyebrow>
        <PageTitle className="mt-3">{title}</PageTitle>
        <p className="mx-auto mt-3 max-w-md text-ink-soft">{description}</p>
        {children}
        {actions ? <div className="mt-6 flex flex-wrap justify-center gap-3">{actions}</div> : null}
      </Card>
    </main>
  );
}
