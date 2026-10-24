"use client";

import { useEffect } from "react";

const COUNT_MS = 1_400;
const NUMBER = new Intl.NumberFormat("fr-FR");

function countUp(element: HTMLElement) {
  const target = Number(element.dataset.countTo);
  const finalText = element.textContent ?? "";
  if (!Number.isFinite(target) || target <= 0) return;
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / COUNT_MS);
    if (progress >= 1) {
      element.textContent = finalText;
      return;
    }
    element.textContent = NUMBER.format(Math.round(target * (1 - (1 - progress) ** 3)));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function inViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0;
}

/**
 * Les apparitions au défilement de l'accueil, sans bibliothèque : les blocs `data-reveal` sont
 * masqués seulement une fois ce script chargé (sans lui, la page s'affiche telle quelle), puis
 * révélés à leur entrée dans l'écran ; les chiffres `data-count-to` comptent jusqu'à leur valeur.
 * Ce qui est déjà visible au chargement n'est ni masqué ni recompté. Rien ne bouge quand le
 * visiteur a demandé de réduire les animations.
 */
export function HomeMotion() {
  useEffect(() => {
    if (!window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;
    const root = document.documentElement;
    const pending = [...document.querySelectorAll<HTMLElement>("[data-reveal]")].filter(
      (element) => {
        if (!inViewport(element)) return true;
        element.dataset.shown = "";
        return false;
      },
    );
    root.dataset.homeMotion = "";
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          element.dataset.shown = "";
          element.querySelectorAll<HTMLElement>("[data-count-to]").forEach(countUp);
          observer.unobserve(element);
        }
      },
      { threshold: 0.2 },
    );
    pending.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      delete root.dataset.homeMotion;
    };
  }, []);
  return null;
}
