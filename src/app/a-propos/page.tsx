import type { Metadata } from "next";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Ban from "lucide-react/dist/esm/icons/ban.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { RESOURCES_PATH } from "@/lib/navigation";
import { Card, Eyebrow, PageTitle, buttonClasses } from "@/components/ui/primitives";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { COMPANY_DESCRIPTION } from "@/lib/company-description";
import { jsonLdString } from "@/lib/json-ld";
import { pageMetadata } from "@/lib/page-metadata";
import { aboutPageStructuredData } from "@/lib/seo";
import { siteOrigin } from "@/lib/site-url";

export const metadata: Metadata = pageMetadata({
  path: "/a-propos",
  title: "À propos",
  description: COMPANY_DESCRIPTION,
});

export default function Page() {
  const origin = siteOrigin();
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdString(aboutPageStructuredData(origin)) }}
      />
      <BreadcrumbJsonLd trail={[{ name: "À propos", path: "/a-propos" }]} />
      <PageContent />
    </>
  );
}

function PageContent() {
  return (
    <main id="contenu" className="min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Card as="section" className="overflow-hidden sm:p-8 lg:p-10">
          <div className="grid gap-8 lg:grid-cols-[1fr_26rem] lg:items-center">
            <div>
              <Eyebrow className="flex items-center gap-3">
                <Landmark className="h-4 w-4" aria-hidden />À propos d’Immojudis
              </Eyebrow>
              <PageTitle className="mt-4 max-w-3xl">
                Rendre les ventes immobilières aux enchères compréhensibles et comparables.
              </PageTitle>
              <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Au tribunal, chez le notaire ou auprès de l’État, les démarches ne sont pas les
                mêmes. Immojudis rassemble les annonces référencées, explique le type de vente et
                aide à préparer sa décision. Une vente notariale ou domaniale n’est pas forcément
                judiciaire.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href={RESOURCES_PATH} className={buttonClasses({ variant: "primary" })}>
                  Lire les ressources <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <Link href="/sales" className={buttonClasses()}>
                  Explorer les ventes
                </Link>
              </div>
            </div>

            <div className="relative min-h-[24rem] overflow-hidden rounded-lg bg-background">
              <img
                src="/media/landing/justice-goddess.webp"
                alt=""
                width={1600}
                height={2400}
                loading="lazy"
                className="absolute -bottom-24 left-1/2 h-[34rem] w-auto -translate-x-1/2 opacity-90"
              />
            </div>
          </div>
        </Card>

        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <AboutCard
            icon={SearchCheck}
            title="Centraliser"
            text="Regrouper les ventes dispersées pour éviter la veille manuelle et les angles morts."
          />
          <AboutCard
            icon={ShieldCheck}
            title="Qualifier"
            text="Mettre en avant les points qui changent vraiment une décision : occupation, frais, risques et preuves."
          />
          <AboutCard
            icon={Landmark}
            title="Préparer"
            text="Aider chaque acheteur à comprendre les conditions de sa vente et à contacter le bon interlocuteur."
          />
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2" aria-label="Transparence">
          <AboutBlock icon={Building2} title="Qui édite Immojudis ?">
            <p>
              Immojudis est édité par la société identifiée dans nos{" "}
              <Link href="/legal" className="text-gold-text underline underline-offset-4">
                mentions légales
              </Link>
              : dénomination, adresse, directeur de la publication et hébergeur y figurent. Nous ne
              les répétons pas ici afin qu’elles restent à un seul endroit, à jour.
            </p>
          </AboutBlock>
          <AboutBlock icon={Database} title="D’où viennent les données ?">
            <p>
              Les annonces proviennent de publications publiques : sites d’annonces spécialisés,
              annonces des notaires, site des cessions immobilières de l’État. Chaque fiche indique
              sa source. Les valeurs de marché s’appuient sur la base Demande de valeurs foncières
              (DVF) de la DGFiP, publiée sur data.gouv.fr.
            </p>
            <p>
              Ces données sont collectées automatiquement : elles peuvent comporter des erreurs ou
              des retards. Vérifiez-les dans les pièces officielles et signalez-nous toute anomalie
              via la{" "}
              <Link href="/contact" className="text-gold-text underline underline-offset-4">
                page contact
              </Link>
              .
            </p>
          </AboutBlock>
          <AboutBlock icon={Scale} title="Indépendance vis-à-vis des tribunaux">
            <p>
              Immojudis n’est rattaché à aucun tribunal, barreau, office notarial ni service de
              l’État. Nous n’organisons, ne conduisons et ne garantissons aucune vente, et nous ne
              portons pas d’enchères : seuls l’organisateur de la vente et, au tribunal, un avocat
              inscrit au barreau compétent le font.
            </p>
          </AboutBlock>
          <AboutBlock icon={Ban} title="Ce que le site ne fait pas">
            <ul className="list-disc space-y-1 pl-5">
              <li>Il ne fournit ni conseil juridique, ni conseil financier personnalisé.</li>
              <li>
                Il ne promet aucun gain, aucune décote et ne garantit aucune estimation : une
                enchère ou une offre plafond est une hypothèse, pas un résultat.
              </li>
              <li>
                Le repère « Pépite » est un repère calculé automatiquement sur des critères publics
                : ce n’est ni une recommandation d’acheter, ni une garantie de prix ou de résultat.
              </li>
              <li>Il ne remplace ni la lecture des pièces, ni votre avocat.</li>
            </ul>
          </AboutBlock>
        </section>
      </div>
    </main>
  );
}

function AboutCard({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Landmark;
  title: string;
  text: string;
}) {
  return (
    <Card as="article">
      <Icon className="h-5 w-5 text-gold-text" />
      <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
    </Card>
  );
}

function AboutBlock({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Landmark;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card as="article">
      <Icon className="h-5 w-5 text-gold-text" />
      <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-foreground">
        {title}
      </h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </Card>
  );
}
