import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResourceCard } from "@/components/resources/ResourceCard";
import { ResourcesNextStep } from "@/components/resources/ResourcesNextStep";
import {
  RESOURCE_ARTICLES,
  RESOURCE_SUMMARIES,
  getResourceArticle,
  formatResourceDate,
} from "@/lib/resource-articles";
import { resolveSiteOrigin } from "@/lib/site-url";
import styles from "@/components/resources/Resources.module.css";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return RESOURCE_ARTICLES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = getResourceArticle(slug);
  if (!article) notFound();

  return {
    title: article.title,
    description: article.description,
    alternates: { canonical: article.href },
    openGraph: {
      type: "article",
      title: article.title,
      description: article.description,
      url: article.href,
      publishedTime: article.publishedAt,
      authors: ["Immojudis"],
      images: [{ url: article.image }],
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
      images: [article.image],
    },
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const article = getResourceArticle(slug);
  if (!article) notFound();

  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        headline: article.title,
        description: article.description,
        datePublished: article.publishedAt,
        author: { "@type": "Organization", name: "Immojudis", url: origin },
        publisher: { "@type": "Organization", name: "Immojudis", url: origin },
        image: `${origin}${article.image}`,
        mainEntityOfPage: `${origin}${article.href}`,
        inLanguage: "fr-FR",
        articleSection: article.category,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Accueil", item: origin },
          { "@type": "ListItem", position: 2, name: "Ressources", item: `${origin}/ressources` },
          {
            "@type": "ListItem",
            position: 3,
            name: article.title,
            item: `${origin}${article.href}`,
          },
        ],
      },
    ],
  };
  const related = RESOURCE_SUMMARIES.filter((item) => item.slug !== slug).slice(0, 3);

  return (
    <main className={styles.root}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="Fil d’Ariane">
          <Link href="/">Accueil</Link>
          <span aria-hidden="true">/</span>
          <Link href="/ressources">Ressources</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{article.category}</span>
        </nav>
        <article>
          <header className={styles.articleHeader}>
            <p className={styles.eyebrow}>{article.category} · Le blog Immojudis</p>
            <h1>{article.title}</h1>
            <p>{article.description}</p>
            <p className={styles.meta}>
              Par la rédaction Immojudis
              {article.publishedAt && (
                <>
                  {" "}
                  ·{" "}
                  <time dateTime={article.publishedAt}>
                    {formatResourceDate(article.publishedAt)}
                  </time>
                </>
              )}{" "}
              · {article.readingMinutes} min de lecture
            </p>
          </header>
          <div className={styles.articleImage}>
            <Image
              src={article.image}
              alt=""
              fill
              sizes="(max-width: 700px) 100vw, 1240px"
              priority
            />
          </div>
          <div className={styles.articleLayout}>
            <nav className={styles.toc} aria-label="Sommaire de l’article">
              <h2>Dans cet article</h2>
              <ol>
                {article.sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`}>{section.title}</a>
                  </li>
                ))}
              </ol>
            </nav>
            <div className={styles.articleBody}>
              {article.intro.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <aside className={styles.takeaways} aria-labelledby="takeaways-title">
                <h2 id="takeaways-title">L’essentiel à retenir</h2>
                <ul>
                  {article.takeaways.map((takeaway) => (
                    <li key={takeaway}>{takeaway}</li>
                  ))}
                </ul>
              </aside>
              {article.sections.map((section) => (
                <section key={section.id} id={section.id}>
                  <h2>{section.title}</h2>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.bullets && (
                    <ul>
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                  {section.table && (
                    <div
                      className={styles.tableWrapper}
                      tabIndex={0}
                      role="region"
                      aria-label={`Tableau : ${section.title}`}
                    >
                      <table>
                        <thead>
                          <tr>
                            {section.table.headers.map((header) => (
                              <th key={header} scope="col">
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {section.table.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <td key={cellIndex}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {section.callout && (
                    <aside className={styles.callout}>
                      <h3>{section.callout.title}</h3>
                      <p>{section.callout.text}</p>
                    </aside>
                  )}
                </section>
              ))}
              <section className={styles.sources} aria-labelledby="sources-title">
                <h2 id="sources-title">Sources et repères utiles</h2>
                <p>
                  Pour vérifier les règles applicables à votre dossier et approfondir cette lecture.
                </p>
                <ul>
                  {article.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.label} <span aria-hidden="true">↗</span>
                        <span className="sr-only"> (nouvel onglet)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
              <p className={styles.meta}>
                Ce guide donne des repères généraux. Les pièces de la vente et l’avis des
                professionnels qui vous accompagnent restent déterminants pour votre projet.
              </p>
            </div>
          </div>
        </article>
        <section className={styles.related} aria-labelledby="related-title">
          <p className={styles.eyebrow}>Pour poursuivre votre lecture</p>
          <h2 id="related-title">Approfondir votre projet.</h2>
          <div className={styles.grid}>
            {related.map((item) => (
              <ResourceCard key={item.slug} article={item} />
            ))}
          </div>
        </section>
        <ResourcesNextStep />
        <footer className={styles.footer}>
          <Link href="/ressources">← Tous les articles</Link>
          <Link href="/contact">Nous contacter</Link>
        </footer>
      </div>
    </main>
  );
}
