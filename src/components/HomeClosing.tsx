import Form from "next/form";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import styles from "./HomeClosing.module.css";

/** Dernière section de l'accueil : la même recherche que le hero, pour finir sur une action. */
export function HomeClosing() {
  return (
    <section className={styles.closing} aria-labelledby="closing-title">
      <div className={styles.content}>
        <div>
          <p className={styles.eyebrow}>Commencer</p>
          <h2 id="closing-title">
            Préparez votre prochaine vente <em>avec méthode.</em>
          </h2>
        </div>
        <Form action="/sales" className={styles.search} role="search">
          <Search size={22} aria-hidden="true" />
          <label className="sr-only" htmlFor="home-search-end">
            Ville, département ou code postal
          </label>
          <input
            id="home-search-end"
            name="q"
            type="search"
            placeholder="Ville, département ou code postal"
          />
          <button type="submit">
            Explorer les ventes <ArrowRight size={19} aria-hidden="true" />
          </button>
        </Form>
      </div>
    </section>
  );
}
