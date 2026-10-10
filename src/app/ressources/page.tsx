import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { ResourceLibrary } from "@/components/resources/ResourceLibrary";
import { ResourcesNextStep } from "@/components/resources/ResourcesNextStep";
import { EXISTING_GUIDE, RESOURCE_SUMMARIES } from "@/lib/resource-articles";
import { resolveSiteOrigin } from "@/lib/site-url";
import styles from "@/components/resources/Resources.module.css";
import { jsonLdString } from "@/lib/json-ld";

const title = "Ressources : le blog des enchères immobilières";
const description =
  "Les guides Immojudis pour comprendre les enchères immobilières, analyser un bien, vérifier son occupation et construire un budget avant d’enchérir.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/ressources" },
  openGraph: {
    title,
    description,
    url: "/ressources",
    type: "website",
    siteName: "Immojudis",
    locale: "fr_FR",
    // Declared here because a page-level openGraph replaces the layout's: without
    // an image, shares of this page would have no preview.
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Immojudis" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
};

export default function Page() {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: `${origin}/ressources`,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: RESOURCE_SUMMARIES.map((article, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: article.title,
        url: `${origin}${article.href}`,
      })),
    },
  };

  return (
    <main id="contenu" className={styles.root}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(structuredData),
        }}
      />
      <div className={styles.container}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>Ressources · Le blog Immojudis</p>
          <h1>
            Comprendre les enchères.
            <br />
            <em>Éclairer vos décisions.</em>
          </h1>
          <p className={styles.heroDescription}>
            Procédures, budget, occupation, potentiel : des guides concrets pour avancer dans votre
            projet immobilier, un sujet à la fois.
          </p>
          <a href="#articles" className={styles.textLink}>
            Parcourir les articles <ArrowRight size={18} aria-hidden="true" />
          </a>
        </header>

        <section className={styles.featured} aria-labelledby="featured-title">
          <div className={styles.featuredArt}>
            <span className={styles.artLabel}>Les fondamentaux</span>
            <Image
              src={EXISTING_GUIDE.image}
              alt=""
              fill
              sizes="(max-width: 700px) 100vw, 42vw"
              loading="eager"
              fetchPriority="high"
            />
            <span className={styles.artCaption}>Comprendre avant d’enchérir</span>
          </div>
          <div className={styles.featuredBody}>
            <p className={styles.eyebrow}>Le guide pour commencer</p>
            <h2 id="featured-title">{EXISTING_GUIDE.title}</h2>
            <p>{EXISTING_GUIDE.description}</p>
            <p className={styles.meta}>
              Guide complet · {EXISTING_GUIDE.readingMinutes} min de lecture
            </p>
            <Link href={EXISTING_GUIDE.href} className={styles.primaryLink}>
              Lire le guide <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <ResourceLibrary articles={RESOURCE_SUMMARIES} />
        <ResourcesNextStep />
        <footer className={styles.footer}>
          <Link href="/">Immojudis</Link>
          <span>Les enchères immobilières en toute clarté.</span>
          <Link href="/contact">Nous contacter</Link>
        </footer>
      </div>
    </main>
  );
}
