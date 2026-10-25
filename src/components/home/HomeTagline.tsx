"use client";

import { useEffect, useRef } from "react";
import styles from "./HomePage.module.css";

const LEAD = "Le bon prix d’une vente aux enchères se décide chez vous,";
const ACCENT = "avant l’audience.";

function Words({ text, accent = false }: { text: string; accent?: boolean }) {
  return text.split(" ").map((word, index) => (
    <span key={`${word}-${index}`}>
      <span data-word="" className={accent ? styles.taglineAccent : undefined}>
        {word}
      </span>{" "}
    </span>
  ));
}

/**
 * La phrase du milieu de page : ses mots passent de 50 % à 100 % d'opacité, un à un, à mesure
 * qu'elle monte dans l'écran. Le défilement n'est écouté (une lecture par image) que tant que la
 * phrase est visible. Sans script ou quand le visiteur réduit les animations, elle s'affiche
 * entière : l'atténuation n'existe que sous `html[data-home-motion]` (posé par `HomeMotion`).
 */
export function HomeTagline() {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const words = [...element.querySelectorAll<HTMLElement>("[data-word]")];
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const height = window.innerHeight;
      const progress = Math.min(1, Math.max(0, (height * 0.85 - rect.top) / (height * 0.5)));
      const lit = Math.round(progress * words.length);
      words.forEach((word, index) => {
        if (index < lit) word.dataset.lit = "";
        else delete word.dataset.lit;
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) window.addEventListener("scroll", onScroll, { passive: true });
      else window.removeEventListener("scroll", onScroll);
      update();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className={styles.taglineSection} aria-label="Notre conviction">
      <div className={styles.container}>
        <p ref={ref} className={styles.tagline}>
          <Words text={LEAD} /> <Words text={ACCENT} accent />
        </p>
      </div>
    </section>
  );
}
