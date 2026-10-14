import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { legalValue, publicLegalPublisher } from "@/lib/legal-documents";

export const metadata: Metadata = {
  alternates: { canonical: "/agent-information" },
  title: "Outil de recherche d’adresses d’Immojudis",
  description:
    "Qui est l’outil de recherche d’adresses d’Immojudis, à quoi il sert, ce qu’il consulte et comment s’y opposer.",
};

/**
 * Page publique de l'outil de recherche d'adresses professionnelles de l'agent d'information.
 * Le user-agent de l'outil renvoie ici : identité, but, limites et moyens de s'opposer, pour les
 * professionnels concernés comme pour les éditeurs des sites consultés (avis juridique du
 * 14/10/2026, section 5.8 et 7). Le détail du traitement figure dans la politique de
 * confidentialité.
 */
export default function Page() {
  const publisher = publicLegalPublisher();
  return (
    <main id="contenu" className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <article className="mx-auto max-w-4xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Outil de recherche d’adresses
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
            L’outil de recherche d’adresses d’Immojudis
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Cette page présente un outil automatisé d’Immojudis : qui l’exploite, à quoi il sert, ce
            qu’il consulte et comment vous y opposer. Elle s’adresse aux professionnels des ventes
            aux enchères (avocats, notaires, commissaires de justice, gestionnaires) et aux éditeurs
            des sites qu’il peut consulter.
          </p>
        </header>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <Section title="Qui l’exploite">
            <p>
              L’outil est exploité par Immojudis, {legalValue(publisher.entityName)}, situé à{" "}
              {legalValue(publisher.address)}. Contact : {legalValue(publisher.contactEmail)}.
            </p>
          </Section>

          <Section title="À quoi il sert">
            <p>
              Lorsqu’un administrateur d’Immojudis prépare une demande d’information sur une vente
              précise, l’outil peut consulter ponctuellement une page publique du professionnel qui
              mène cette vente pour retrouver son adresse professionnelle : l’annonce de la vente,
              sa fiche dans un annuaire professionnel officiel ou le site de son cabinet ou de son
              étude. Cette adresse ne sert qu’à lui écrire au sujet de cette vente. L’outil ne fait
              aucune prospection : les messages ne contiennent aucune offre commerciale, et chacun
              est relu et validé par un membre de l’équipe avant envoi.
            </p>
          </Section>

          <Section title="Ce qu’il fait, et ce qu’il ne fait pas">
            <ul className="list-disc space-y-1 pl-5">
              <li>Il cherche un seul professionnel à la fois, pour une vente précise.</li>
              <li>
                Il lit des pages précises (une fiche, une page de contact ou de mentions légales),
                jamais un annuaire entier : aucune pagination, aucun formulaire de recherche, aucune
                copie d’annuaire.
              </li>
              <li>
                Il respecte le fichier robots.txt de chaque site, avance à un rythme lent et
                s’arrête dès qu’un site le lui refuse ; il ne contourne aucun blocage.
              </li>
              <li>
                Il ne conserve ni la page lue ni une copie d’annuaire. Seuls sont enregistrés
                l’adresse retenue, l’adresse web de la page, la date de consultation et le nom de la
                personne qui a validé. Une liste de noms et d’adresses web peut être gardée en
                mémoire 24 heures au plus ; le journal des consultations (site, page, résultat,
                date), sans contenu, est conservé 6 mois au plus.
              </li>
              <li>
                Une adresse qui n’est finalement pas utilisée pour un envoi est supprimée sous 30
                jours.
              </li>
              <li>
                Il s’identifie à chaque requête : le nom de l’outil et l’adresse de cette page
                figurent dans son identifiant de navigation (user-agent).
              </li>
            </ul>
          </Section>

          <Section title="Comment vous y opposer">
            <p>
              Vous pouvez vous opposer à tout moment, sans motif. Si vous avez reçu un message,
              utilisez le lien « Ne plus être contacté » qu’il contient, ou répondez-y. Sinon,
              écrivez à {legalValue(publisher.contactEmail)} en indiquant votre nom et votre barreau
              ou votre ville. Votre opposition est enregistrée pour votre adresse et pour votre
              identité : elle vaut pour tous nos canaux, et vous ne serez plus sollicité sous une
              autre adresse.
            </p>
            <p className="mt-3">
              Éditeurs de sites : pour que l’outil ne consulte plus tout ou partie de votre site,
              ajoutez-le à votre fichier robots.txt ou écrivez à{" "}
              {legalValue(publisher.contactEmail)}.
            </p>
          </Section>

          <Section title="Vos droits">
            <p>
              Vous pouvez demander l’accès, la rectification, l’effacement ou la limitation du
              traitement de vos données, ou saisir la{" "}
              <a
                href="https://www.cnil.fr/fr/plaintes"
                className="text-gold underline"
                target="_blank"
                rel="noreferrer"
              >
                CNIL
              </a>
              . Le traitement complet (base juridique, durées, destinataires) est décrit dans la{" "}
              <Link href="/privacy" className="text-gold underline">
                politique de confidentialité
              </Link>
              .
            </p>
          </Section>
        </div>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="liquid-panel-soft rounded-lg p-5 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
