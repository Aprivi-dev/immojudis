import Link from "next/link";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";

/** Decorative placeholders only: protected values are never rendered under the blur. */
export function PremiumFeaturePreview({
  title,
  description,
  labels,
}: {
  title: string;
  description: string;
  labels: readonly string[];
}) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-gold/25 bg-white p-5 sm:p-6"
      aria-label={title}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3" aria-hidden="true">
        {labels.map((label) => (
          <div key={label} className="rounded-lg border border-border bg-stone-50 p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="mt-3 select-none blur-[5px]">
              <div className="h-6 w-3/4 rounded bg-slate-300" />
              <div className="mt-3 h-2 w-full rounded bg-slate-200" />
              <div className="mt-2 h-2 w-2/3 rounded bg-slate-200" />
            </div>
          </div>
        ))}
      </div>
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold-soft">
        <LockKeyhole aria-hidden className="h-4 w-4" /> Premium · offre Analyse
      </p>
      <h3 className="mt-2 font-display text-2xl text-foreground">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Pour un premier accès éligible : 7 jours d’essai gratuits avec carte bancaire, puis
        abonnement récurrent. Un compte ayant déjà utilisé l’essai souscrit directement. Résiliation
        depuis le portail Stripe.
      </p>
      <Link
        href="/accompagnement"
        className="mt-4 inline-flex rounded-lg bg-gold px-4 py-3 text-sm font-semibold text-brand-navy hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
      >
        Découvrir l’essai Premium
      </Link>
    </section>
  );
}
