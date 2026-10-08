import Image from "next/image";
import Link from "next/link";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import type { ResourceSummary } from "@/lib/resource-articles";
import styles from "./Resources.module.css";

export function ResourceCard({ article }: { article: ResourceSummary }) {
  return (
    <article className={styles.card}>
      <Link
        href={article.href}
        className={styles.cardLink}
        aria-labelledby={`title-${article.slug}`}
      >
        <div className={styles.cardImage}>
          <Image
            src={article.image}
            alt=""
            fill
            sizes="(max-width: 700px) 100vw, (max-width: 1050px) 50vw, 33vw"
          />
          <span className={styles.imageLabel}>{article.category}</span>
        </div>
        <div className={styles.cardBody}>
          <p className={styles.meta}>{article.readingMinutes} min de lecture</p>
          <h3 id={`title-${article.slug}`}>{article.title}</h3>
          <p className={styles.cardDescription}>{article.description}</p>
          <span className={styles.textLink}>
            Lire l’article <ArrowUpRight size={18} aria-hidden="true" />
          </span>
        </div>
      </Link>
    </article>
  );
}
