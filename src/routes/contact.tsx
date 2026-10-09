"use client";

import { createFileRoute, Link } from "@/lib/router-compat";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import { ContactForm } from "@/components/ContactForm";
import { Card, PageShell } from "@/components/ui/primitives";
import { publicLegalPublisher } from "@/lib/legal-documents";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact — Immojudis" },
      {
        name: "description",
        content: "Contacter l'équipe Immojudis.",
      },
    ],
  }),
  component: ContactPage,
});

export function ContactPage() {
  const publisher = publicLegalPublisher();
  return (
    <PageShell
      eyebrow="Contact"
      title="Une question sur une vente, un accès ou vos données ?"
      description="Écrivez-nous : nous répondons par email. Si votre question concerne une annonce, indiquez son adresse ou son identifiant pour accélérer la réponse."
      width="wide"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <Card as="section" aria-labelledby="contact-form-title">
          <h2 id="contact-form-title" className="font-display text-2xl font-semibold">
            Envoyer un message
          </h2>
          <div className="mt-4">
            <ContactForm />
          </div>
        </Card>

        <div className="grid gap-4">
          <Card as="section" aria-labelledby="contact-direct">
            <h2 id="contact-direct" className="font-display text-xl font-semibold">
              Par email ou par téléphone
            </h2>
            {publisher.contactEmail ? (
              <p className="mt-2 text-sm">
                <a
                  className="font-semibold text-gold-text underline"
                  href={`mailto:${publisher.contactEmail}?subject=${encodeURIComponent("Question sur Immojudis")}`}
                >
                  {publisher.contactEmail}
                </a>
              </p>
            ) : (
              <p className="mt-2 text-sm text-ink-soft">
                Les coordonnées directes seront publiées ici avant l’ouverture des achats Analyse.
                Le formulaire reste le moyen le plus simple de nous écrire.
              </p>
            )}
            {publisher.contactPhone ? (
              <p className="mt-2 text-sm">
                Téléphone :{" "}
                <a
                  className="font-semibold text-gold-text underline"
                  href={`tel:${publisher.contactPhone.replace(/[^+\d]/g, "")}`}
                >
                  {publisher.contactPhone}
                </a>
              </p>
            ) : null}
          </Card>

          <Card as="section" aria-labelledby="contact-rights">
            <h2 id="contact-rights" className="font-display text-xl font-semibold">
              Exercer vos droits
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              Pour une demande sur vos données personnelles ou une rétractation, utilisez l’espace
              connecté : vous obtenez un numéro de suivi et une échéance.
            </p>
            <Link
              to="/mes-droits"
              className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-gold-text underline"
            >
              Ouvrir Mes droits <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Card>

          <Card as="section" aria-labelledby="contact-pro">
            <h2 id="contact-pro" className="font-display text-xl font-semibold">
              Vous êtes professionnel ?
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              L’espace professionnel permet de préparer une annonce et ses pièces.
            </p>
            <Link
              to="/publish"
              className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-gold-text underline"
            >
              Préparer une annonce <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
