import Mail from "lucide-react/dist/esm/icons/mail.js";
import Phone from "lucide-react/dist/esm/icons/phone.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import type { Property } from "@/lib/property-types";
import { formatCurrency } from "@/lib/format";
import { PropertyImage } from "./PropertyImage";

export function StickyContactCard({ property }: { property: Property }) {
  const agent = property.agent;
  const mailto = agent?.email
    ? `mailto:${agent.email}?subject=${encodeURIComponent(`Demande d'information - ${property.title}`)}`
    : undefined;

  return (
    <>
      <aside className="hidden lg:block">
        <div className="sticky top-28 rounded-md border border-border bg-white p-5 shadow-xl shadow-slate-900/8">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Contacter
          </div>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-12 w-12 overflow-hidden rounded-full border border-border bg-muted">
              {agent?.avatarUrl ? (
                <PropertyImage
                  src={agent.avatarUrl}
                  alt={agent.name}
                  className="object-contain p-2"
                />
              ) : (
                <div className="h-full w-full bg-muted" />
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">
                {agent?.name ?? "Equipe Immojudis"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {agent?.brokerage ?? "Contact commercial"}
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-md border border-border bg-muted/35 p-4">
            <div className="text-xs text-muted-foreground">Prix affiche</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">
              {formatCurrency(property.price, property.currency)}
            </div>
          </div>

          <div className="mt-4 grid gap-2">
            {agent?.phone && (
              <a
                href={`tel:${agent.phone.replaceAll(" ", "")}`}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
              >
                <Phone className="h-4 w-4" />
                Appeler
              </a>
            )}
            <a
              href={mailto ?? "/contact"}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-foreground px-4 text-sm font-semibold text-white transition-colors hover:bg-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <Mail className="h-4 w-4" />
              Demander une visite
            </a>
          </div>

          <form className="mt-5 grid gap-3" onSubmit={(event) => event.preventDefault()}>
            <label className="grid gap-1 text-xs font-semibold text-foreground">
              Email
              <input
                type="email"
                required
                className="h-10 rounded-md border border-border bg-white px-3 text-sm outline-none transition-colors focus:border-gold"
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-foreground">
              Message
              <textarea
                rows={3}
                defaultValue={`Bonjour, je souhaite recevoir plus d'informations sur ${property.title}.`}
                className="rounded-md border border-border bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-gold"
              />
            </label>
            <button
              type="submit"
              className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-white px-4 text-xs font-semibold uppercase tracking-[0.12em] text-foreground transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <Send className="h-4 w-4" />
              Envoyer
            </button>
          </form>
        </div>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 p-3 shadow-[0_-16px_38px_rgba(15,23,42,0.14)] backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {formatCurrency(property.price, property.currency)}
            </div>
            <div className="truncate text-xs text-muted-foreground">{property.city}</div>
          </div>
          <a
            href={mailto ?? "/contact"}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-foreground px-4 text-sm font-semibold text-white transition-colors hover:bg-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            Contacter
          </a>
        </div>
      </div>
    </>
  );
}
