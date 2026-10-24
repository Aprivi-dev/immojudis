"use client";

import { useEffect, useRef } from "react";
import Form from "next/form";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import styles from "./HomePage.module.css";

const PLACEHOLDER = "Ville, département ou code postal";
/** Exemples écrits l'un après l'autre dans le champ vide (lieux que la recherche reconnaît). */
const TYPED_EXAMPLES = ["Bordeaux", "Lyon", "Seine-Saint-Denis", "Nantes", "Marseille"];
const TYPE_MS = 90;
const ERASE_MS = 45;
const HOLD_MS = 1_600;
const START_MS = 1_400;

/**
 * Champ de recherche de l'accueil (envoie vers /sales?q=…). Tant qu'il est vide, sans le focus et
 * quand le visiteur accepte les animations, son texte indicatif écrit des exemples de lieux ; le
 * libellé, lui, ne change pas.
 */
export function HomeSearch({ id, tone = "light" }: { id: string; tone?: "light" | "dark" }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (
      !input ||
      !window.matchMedia ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let example = 0;
    let length = 0;
    let erasing = false;
    const idle = () => document.activeElement !== input && input.value === "";
    const tick = () => {
      if (!idle()) {
        input.placeholder = PLACEHOLDER;
        timer = setTimeout(tick, HOLD_MS);
        return;
      }
      const word = TYPED_EXAMPLES[example];
      length += erasing ? -1 : 1;
      input.placeholder = `Ex. : ${word.slice(0, length)}`;
      let delay = erasing ? ERASE_MS : TYPE_MS;
      if (!erasing && length === word.length) {
        erasing = true;
        delay = HOLD_MS;
      } else if (erasing && length === 0) {
        erasing = false;
        example = (example + 1) % TYPED_EXAMPLES.length;
        delay = 300;
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, START_MS);
    return () => {
      clearTimeout(timer);
      input.placeholder = PLACEHOLDER;
    };
  }, []);

  return (
    <Form
      action="/sales"
      className={`${styles.search} ${tone === "dark" ? styles.searchDark : ""}`}
      role="search"
    >
      <Search size={20} aria-hidden="true" />
      <label className="sr-only" htmlFor={id}>
        {PLACEHOLDER}
      </label>
      <input ref={inputRef} id={id} name="q" type="search" placeholder={PLACEHOLDER} />
      <button type="submit">
        <span>Voir les ventes</span> <ArrowRight size={18} aria-hidden="true" />
      </button>
    </Form>
  );
}
