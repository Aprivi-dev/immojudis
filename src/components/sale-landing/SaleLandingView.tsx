import type { ReactNode } from "react";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { UpcomingSaleWeeks } from "@/components/departments/UpcomingSaleWeeks";
import { Card, Eyebrow, PageTitle, buttonClasses } from "@/components/ui/primitives";
import { DEPARTMENT_PAGES_PATH, departmentItemListStructuredData } from "@/lib/department-pages";
import { formatDate } from "@/lib/format";
import { jsonLdString } from "@/lib/json-ld";
import { EXISTING_GUIDE, getResourceArticle } from "@/lib/resource-articles";
import {
  SALE_LANDING_PAGES,
  saleLandingSearchPath,
  visibleSaleLandingKeys,
  type SaleLandingData,
  type SaleLandingPage,
} from "@/lib/sale-landing-pages";
import { siteOrigin } from "@/lib/site-url";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat("fr-FR");

const TEXT_LINK = "font-semibold text-gold-text underline";

/** Une section du guide d'une page (titre de niveau 2 et texte). */
export function SaleLandingSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-11">
      <h2 id={id} className="font-display text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-3 grid max-w-[45rem] gap-3 text-ink-strong">{children}</div>
    </section>
  );
}

/**
 * Page d'atterrissage par type de bien ou de vente (`sale-landing-pages.ts`), rendue côté serveur :
 * fil d'Ariane, titre-phrase, prochaines ventes groupées par semaine (comme une page de département),
 * guide propre à la page (`children`), puis les liens vers les autres pages et les articles.
 * `data` vaut `null` quand la base n'a pas pu être lue pendant le build.
 */
export function SaleLandingView({
  page,
  data,
  eyebrow,
  heading,
  intro,
  articleSlugs,
  children,
}: {
  page: SaleLandingPage;
  data: SaleLandingData | null;
  eyebrow: string;
  /** Contenu du h1, accordé au nombre de ventes. */
  heading: ReactNode;
  intro: string;
  /** Articles de `/ressources` proposés dans « Pour comprendre » (un article absent est ignoré). */
  articleSlugs: readonly string[];
  children: ReactNode;
}) {
  const now = new Date();
  const total = data?.upcomingCount ?? 0;
  const sales = data?.sales ?? [];
  const searchHref = saleLandingSearchPath(page);
  const updated = data ? formatDate(data.generatedAt, null) : null;
  const itemList = departmentItemListStructuredData(siteOrigin(), sales);
  const others = visibleSaleLandingKeys()
    .filter((key) => key !== page.key)
    .map((key) => SALE_LANDING_PAGES[key]);
  const articles = articleSlugs.flatMap((slug) => {
    const article = getResourceArticle(slug);
    return article ? [article] : [];
  });

  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: page.label, path: page.path }]} />
      {itemList ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdString(itemList) }}
        />
      ) : null}
      <main id="contenu" className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-6">
        <nav aria-label="Fil d’Ariane" className="pt-5 text-caption text-ink-soft">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <li>
              <Link href="/" className="underline-offset-2 hover:underline">
                Accueil
              </Link>
            </li>
            <li aria-hidden>›</li>
            <li aria-current="page">{page.label}</li>
          </ol>
        </nav>

        <header className="pt-5 pb-2">
          <Eyebrow>{eyebrow}</Eyebrow>
          <PageTitle className="mt-3 max-w-[56rem] leading-snug">{heading}</PageTitle>
          <p className="mt-3 max-w-[41rem] text-base text-ink-soft">
            {intro}
            {updated ? ` D’après le catalogue public au ${updated}.` : ""}
          </p>
          {data == null ? (
            <p role="status" className="mt-4 text-ink-soft">
              La liste des ventes est momentanément indisponible ; la recherche reste accessible.
            </p>
          ) : null}
          <div className="mt-[1.125rem] flex flex-wrap gap-2">
            <Link href={searchHref} className={buttonClasses({ variant: "dark", size: "lg" })}>
              {total > 1
                ? `Voir les ${count.format(total)} ventes dans la recherche`
                : total === 1
                  ? "Voir la vente dans la recherche"
                  : "Ouvrir la recherche"}
            </Link>
          </div>
        </header>

        <div className="mt-9 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22.5rem]">
          <div className="min-w-0">
            <section aria-labelledby="ventes">
              <h2 id="ventes" className="font-display text-2xl font-semibold">
                Les prochaines ventes
              </h2>
              {sales.length > 0 ? (
                <>
                  {/* « Retour » de la fiche mène à la recherche filtrée de la page : ces pages ne
                      sont pas une origine reconnue de `safeSalesReturnTo`, `/sales?…` l'est. */}
                  <UpcomingSaleWeeks sales={sales} now={now} returnTo={searchHref} showDepartment />
                  {sales.length < total ? (
                    <p className="mt-4 text-sm text-ink-soft">
                      Les {count.format(sales.length)} prochaines ventes sont listées ici ; les
                      autres sont dans{" "}
                      <Link href={searchHref} className={TEXT_LINK}>
                        la recherche
                      </Link>
                      .
                    </p>
                  ) : null}
                </>
              ) : (
                <Card className="mt-4">
                  <p className="text-ink-soft">
                    {data
                      ? "Aucune vente à venir n’est référencée pour le moment. Le catalogue est mis à jour régulièrement."
                      : "Les ventes n’ont pas pu être lues."}
                  </p>
                  <Link
                    href={searchHref}
                    className={cn(buttonClasses({ variant: "secondary" }), "mt-3")}
                  >
                    Ouvrir la recherche
                  </Link>
                </Card>
              )}
            </section>

            {children}

            <p className="mt-8 max-w-[45rem] text-xs leading-relaxed text-ink-soft">
              Ventes lues dans le catalogue public{updated ? ` au ${updated}` : ""} ; la liste peut
              évoluer et ne couvre que les sources référencées par Immojudis. Seuls le cahier des
              conditions de vente, le cahier des charges et les pièces officielles font foi. Ces
              informations ne constituent pas un conseil juridique.
            </p>
          </div>

          <aside aria-label="Pour aller plus loin" className="grid gap-3 lg:sticky lg:top-24">
            <Card as="section" aria-labelledby="autres-ventes">
              <h2 id="autres-ventes" className="text-lg font-bold">
                Autres ventes
              </h2>
              <ul className="mt-3 grid gap-2">
                {others.map((other) => (
                  <li key={other.key}>
                    <Link href={other.path} className={TEXT_LINK}>
                      {other.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link href={DEPARTMENT_PAGES_PATH} className={TEXT_LINK}>
                    Ventes par département
                  </Link>
                </li>
                <li>
                  <Link href="/tribunaux" className={TEXT_LINK}>
                    Tribunaux et leur activité
                  </Link>
                </li>
              </ul>
            </Card>
            <Card as="section" aria-labelledby="comprendre">
              <h2 id="comprendre" className="text-lg font-bold">
                Pour comprendre
              </h2>
              <ul className="mt-3 divide-y divide-line-soft">
                <li className="py-2.5">
                  <Link href={EXISTING_GUIDE.href} className={TEXT_LINK}>
                    Le guide des ventes immobilières judiciaires
                  </Link>
                </li>
                {articles.map((article) => (
                  <li key={article.slug} className="py-2.5">
                    <Link href={article.href} className={TEXT_LINK}>
                      {article.title}
                    </Link>
                    <span className="block text-caption text-ink-soft">
                      {article.readingMinutes} min de lecture
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm">
                <Link href="/ressources" className={TEXT_LINK}>
                  Tous les articles
                </Link>
              </p>
            </Card>
          </aside>
        </div>
      </main>
    </>
  );
}
