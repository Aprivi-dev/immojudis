"use client";

import { useState } from "react";
import type { ResourceSummary } from "@/lib/resource-articles";
import { ResourceCard } from "./ResourceCard";
import styles from "./Resources.module.css";

export function ResourceLibrary({ articles }: { articles: ResourceSummary[] }) {
  const [category, setCategory] = useState("Tous");
  const categories = ["Tous", ...new Set(articles.map((article) => article.category))];
  const visible =
    category === "Tous" ? articles : articles.filter((article) => article.category === category);

  return (
    <section className={styles.library} id="articles" aria-labelledby="articles-title">
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>La bibliothèque Immojudis</p>
          <h2 id="articles-title">À chaque question, une lecture.</h2>
        </div>
        <p className={styles.articleCount} role="status">
          {visible.length} article{visible.length > 1 ? "s" : ""}
        </p>
      </div>
      <div className={styles.filters} role="group" aria-label="Filtrer les articles par thème">
        {categories.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === category}
            onClick={() => setCategory(item)}
            aria-controls="resource-results"
          >
            {item}
          </button>
        ))}
      </div>
      <div id="resource-results" className={styles.grid}>
        {visible.map((article) => (
          <ResourceCard key={article.slug} article={article} />
        ))}
      </div>
    </section>
  );
}
