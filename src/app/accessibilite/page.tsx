import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { Card, PageShell } from "@/components/ui/primitives";
import { legalValue, publicLegalPublisher } from "@/lib/legal-documents";
import { pageMetadata } from "@/lib/page-metadata";

const ACCESSIBILITY_STATEMENT_DATE = "31 octobre 2026";

export const metadata: Metadata = pageMetadata({
  path: "/accessibilite",
  title: "Déclaration d’accessibilité",
  description:
    "État d’accessibilité du site Immojudis : non évalué, contenus connus pour ne pas être accessibles, moyen de nous écrire et voies de recours.",
});

/**
 * Contenus dont on sait aujourd'hui qu'ils ne respectent pas le critère visé (constats de l'audit
 * partiel du 31/10/2026). La correction est en cours : cette liste se met à jour avec elle.
 */
const KNOWN_ISSUES = [
  {
    title: "Contraste des bordures de certains champs",
    text: "Les bordures des champs du simulateur de frais, de la recherche d’annonces et de l’explorateur des tribunaux ont un contraste d’environ 1,5 pour 1 avec le fond, alors que 3 pour 1 est attendu (RGAA, critère 3.3 ; WCAG 1.4.11). Une personne malvoyante peut avoir du mal à repérer le champ.",
  },
  {
    title: "Contraste de l’indicateur de focus au clavier",
    text: "Le contour doré qui montre l’élément actif au clavier, notamment sur le bouton « Fermer » des fenêtres, a un contraste d’environ 2,9 pour 1, alors que 3 pour 1 est attendu (RGAA, critère 10.7).",
  },
  {
    title: "Galerie de photos",
    text: "Le passage d’une photo à l’autre n’est pas annoncé par les lecteurs d’écran. La photo change, mais une personne qui n’a pas accès à l’image n’en est pas informée.",
  },
] as const;

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Déclaration d’accessibilité", path: "/accessibilite" }]} />
      <PageContent />
    </>
  );
}

function PageContent() {
  const publisher = publicLegalPublisher();
  const contactEmail = legalValue(publisher.contactEmail);

  return (
    <PageShell
      eyebrow="Accessibilité"
      title="Déclaration d’accessibilité"
      description="Cette page dit où en est Immojudis sur l’accessibilité de son site aux personnes en situation de handicap : ce qui a été vérifié, ce que nous savons ne pas fonctionner, et comment nous écrire."
      width="narrow"
    >
      <p className="mb-5 text-sm text-ink-soft">
        Déclaration établie le {ACCESSIBILITY_STATEMENT_DATE}. Elle porte sur le site immojudis.com.
      </p>

      <div className="grid gap-6">
        <Card as="section" aria-labelledby="etat">
          <h2 id="etat" className="font-display text-2xl font-semibold">
            État de conformité : non évalué
          </h2>
          <p className="mt-2 leading-relaxed text-ink-soft">
            Aucun audit complet n’a été réalisé à ce jour. Le site n’a pas été évalué au regard du
            RGAA, le référentiel général d’amélioration de l’accessibilité (version 4.1.2), qui
            décline les règles internationales WCAG. Immojudis ne peut donc affirmer ni que le site
            est conforme, ni qu’il l’est partiellement.
          </p>
          <p className="mt-3 leading-relaxed text-ink-soft">
            Quelques vérifications existent déjà : la langue de la page est déclarée, un lien permet
            de passer directement au contenu, et les fenêtres et les onglets suivent les modèles
            d’interaction recommandés (WAI-ARIA). Elles ne remplacent pas un audit : elles ne
            couvrent qu’une partie des critères.
          </p>
        </Card>

        <Card as="section" aria-labelledby="contenus">
          <h2 id="contenus" className="font-display text-2xl font-semibold">
            Contenus que nous savons non accessibles
          </h2>
          <p className="mt-2 leading-relaxed text-ink-soft">
            Voici les défauts constatés lors de nos vérifications. Leur correction est en cours.
            Cette liste n’est pas complète, puisqu’aucun audit complet n’a eu lieu.
          </p>
          <ul className="mt-4 grid gap-4">
            {KNOWN_ISSUES.map((issue) => (
              <li key={issue.title}>
                <h3 className="font-semibold">{issue.title}</h3>
                <p className="mt-1 leading-relaxed text-ink-soft">{issue.text}</p>
              </li>
            ))}
          </ul>
          <h3 className="mt-6 font-semibold">Contenus non évalués</h3>
          <p className="mt-1 leading-relaxed text-ink-soft">
            Les cartes interactives et les pièces des dossiers (cahier des conditions de vente,
            procès-verbaux, diagnostics), publiées par les tribunaux ou les professionnels sous
            forme de documents PDF, n’ont pas été évaluées. Ce sont des documents de tiers : ils
            peuvent ne pas être accessibles.
          </p>
        </Card>

        <Card as="section" aria-labelledby="contact">
          <h2 id="contact" className="font-display text-2xl font-semibold">
            Signaler un défaut ou demander une alternative
          </h2>
          <p className="mt-2 leading-relaxed text-ink-soft">
            Si un contenu du site vous est inaccessible, écrivez-nous à {contactEmail} ou depuis la{" "}
            <Link href="/contact" className="font-semibold text-gold-text underline">
              page Contact
            </Link>
            . Indiquez l’adresse de la page, le problème rencontré et, si vous le souhaitez, l’outil
            que vous utilisez (lecteur d’écran, navigation au clavier, agrandissement). Nous
            chercherons une solution, par exemple en vous transmettant l’information sous une autre
            forme.
          </p>
        </Card>

        <Card as="section" aria-labelledby="recours">
          <h2 id="recours" className="font-display text-2xl font-semibold">
            Voies de recours
          </h2>
          <p className="mt-2 leading-relaxed text-ink-soft">
            Cette procédure est à utiliser dans le cas suivant : vous avez signalé au responsable du
            site un défaut d’accessibilité qui vous empêche d’accéder à un contenu ou à un service,
            et vous n’avez pas obtenu de réponse satisfaisante. Vous pouvez alors :
          </p>
          <ul className="mt-3 grid list-disc gap-2 pl-6 text-ink-soft">
            <li>
              écrire un message au{" "}
              <a
                href="https://www.defenseurdesdroits.fr/nous-contacter-355"
                className="font-semibold text-gold-text underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Défenseur des droits
                <span className="sr-only"> (nouvel onglet)</span>
              </a>{" "}
              ;
            </li>
            <li>
              contacter le{" "}
              <a
                href="https://www.defenseurdesdroits.fr/carte-des-delegues"
                className="font-semibold text-gold-text underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                délégué du Défenseur des droits de votre région
                <span className="sr-only"> (nouvel onglet)</span>
              </a>{" "}
              ;
            </li>
            <li>
              envoyer un courrier, sans affranchissement : Défenseur des droits, Libre réponse
              71120, 75342 Paris CEDEX 07.
            </li>
          </ul>
        </Card>

        <Card as="section" aria-labelledby="references" className="bg-surface-muted">
          <h2 id="references" className="font-display text-xl font-semibold">
            Références
          </h2>
          <ul className="mt-3 grid list-disc gap-2 pl-6 text-ink-soft">
            <li>
              <a
                href="https://accessibilite.numerique.gouv.fr/obligations/declaration-accessibilite/"
                className="font-semibold text-gold-text underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Contenu d’une déclaration d’accessibilité (accessibilite.numerique.gouv.fr)
                <span className="sr-only"> (nouvel onglet)</span>
              </a>
            </li>
            <li>
              <a
                href="https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000809647/"
                className="font-semibold text-gold-text underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Loi n° 2005-102 du 11 février 2005, article 47 (Légifrance)
                <span className="sr-only"> (nouvel onglet)</span>
              </a>
            </li>
          </ul>
        </Card>
      </div>
    </PageShell>
  );
}
