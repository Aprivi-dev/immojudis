"use client";

import { useEffect } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";

/** Distance de défilement (px) pendant laquelle chaque scène épinglée reste à l'écran. */
const DOSSIER_SCROLL = 1_800;
const CLOSING_SCROLL = 1_500;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
/** Avancement de `value` entre `from` et `to`, borné à 0-1. */
const span = (value: number, from: number, to: number) => clamp((value - from) / (to - from));
const mix = (from: number, to: number, t: number) => from + (to - from) * t;

function pageTop(element: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null)
    top += node.offsetTop;
  return top;
}

/**
 * Le mouvement des sections peintes de l'accueil, mesuré sur le site de référence (24/11/2026) :
 * - la scène du dossier s'épingle : ses éléments arrivent de derrière l'écran, trois phrases se
 *   relaient au centre ;
 * - la peinture du dernier écran entre à 40 % et grandit jusqu'à remplir l'écran ;
 * - les blocs `data-home-fx` montent, se posent ou convergent à leur entrée dans l'écran ;
 * - les boucles vidéo des peintures ne sont chargées et lues qu'à l'approche de l'écran.
 * Une lecture du défilement par image. Tout est posé par `html[data-home-scenes]` : sans ce script,
 * ou quand le visiteur réduit les animations, la page reste fixe et entièrement lisible.
 */
export function HomeScrollScenes() {
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (reducedMotion) return;
    const root = document.documentElement;
    const all = <T extends HTMLElement = HTMLElement>(selector: string) => [
      ...document.querySelectorAll<T>(selector),
    ];
    const dossier = document.querySelector<HTMLElement>('[data-home-scene="dossier"]');
    const closing = document.querySelector<HTMLElement>('[data-home-scene="closing"]');
    const heroCopy = document.querySelector<HTMLElement>('[data-home-scene="hero-copy"]');
    const lines = all("[data-home-line]");
    const fliers = all("[data-home-flier]").map((element) => ({
      element,
      start: Number(element.dataset.homeFlier),
    }));
    const grow = document.querySelector<HTMLElement>("[data-home-grow]");
    const growOne = document.querySelector<HTMLElement>("[data-home-grow-one]");
    const growTwo = document.querySelector<HTMLElement>("[data-home-grow-two]");
    const effects = all("[data-home-fx]").map((element) => {
      const [x = 0, y = 0] = (element.dataset.homeFrom ?? "").split(",").map(Number);
      return { element, kind: element.dataset.homeFx, x, y, top: 0 };
    });

    root.dataset.homeScenes = "";
    root.style.setProperty("--home-dossier-scroll", `${DOSSIER_SCROLL}px`);
    root.style.setProperty("--home-closing-scroll", `${CLOSING_SCROLL}px`);

    let viewport = 0;
    let wide = true;
    let dossierTop = 0;
    let closingTop = 0;
    const measure = () => {
      viewport = window.innerHeight;
      wide = window.innerWidth >= 960;
      dossierTop = dossier ? pageTop(dossier) : 0;
      closingTop = closing ? pageTop(closing) : 0;
      // Position mesurée sans le décalage d'entrée en cours.
      for (const effect of effects) {
        effect.element.style.transform = "";
        effect.top = pageTop(effect.element);
      }
    };

    const draw = () => {
      const y = window.scrollY;
      if (heroCopy && y < viewport * 1.2)
        heroCopy.style.transform = `translateY(${(y * 0.12).toFixed(1)}px)`;

      if (
        dossier &&
        y > dossierTop - viewport * 1.2 &&
        y < dossierTop + DOSSIER_SCROLL + viewport
      ) {
        // Avant l'arrêt, la première phrase rétrécit de 1,5 à 1 ; pendant l'arrêt, tout se joue.
        const before = span(y, dossierTop - viewport, dossierTop);
        const pinned = span(y, dossierTop, dossierTop + DOSSIER_SCROLL);
        const out1 = span(pinned, 0, 0.2);
        const in2 = span(pinned, 0.13, 0.33);
        const out2 = span(pinned, 0.53, 0.73);
        const in3 = span(pinned, 0.7, 0.92);
        const states: Array<[scale: number, opacity: number]> = [
          [mix(mix(1.5, 1, before), 0.7, out1), 1 - out1],
          [mix(mix(1.2, 1, in2), 0.7, out2), in2 * (1 - out2)],
          [mix(1.2, 1, in3), in3],
        ];
        lines.forEach((line, index) => {
          const [scale, opacity] = states[index] ?? [1, 0];
          line.style.transform = `scale(${scale.toFixed(3)})`;
          line.style.opacity = String(opacity);
        });
        for (const { element, start } of fliers) {
          const t = span(pinned, start, 1);
          element.style.transform = `translateZ(${(1000 * (1 - t)).toFixed(1)}px)`;
          element.style.opacity = String(clamp(t * 12));
        }
      }

      if (closing && grow && growOne && growTwo && y > closingTop - viewport * 1.2) {
        const entering = span(y, closingTop - viewport, closingTop);
        const pinned = span(y, closingTop, closingTop + CLOSING_SCROLL);
        const out = span(pinned, 0.35, 0.6);
        const action = span(pinned, 0.5, 0.78);
        grow.style.transform = `translateY(${(48 * (1 - entering)).toFixed(1)}px) scale(${mix(0.4, 1, span(pinned, 0, 0.5)).toFixed(4)})`;
        growOne.style.transform = `scale(${mix(1, 0.8, out).toFixed(3)})`;
        growOne.style.opacity = String(1 - out);
        growTwo.style.transform = `scale(${mix(0.8, 1, action).toFixed(3)})`;
        growTwo.style.opacity = String(action);
        growTwo.style.pointerEvents = action > 0.5 ? "auto" : "none";
      }

      for (const { element, kind, x, y: fromY, top } of effects) {
        const t = span(y + viewport, top, top + viewport * 0.42);
        if (kind === "rise") {
          const line = element.firstElementChild as HTMLElement | null;
          const up = span(y + viewport, top + 20, top + viewport * 0.34);
          if (line) line.style.transform = `translateY(${(108 * (1 - up)).toFixed(1)}%)`;
        } else if (kind === "pop") {
          element.style.transform = `scale(${mix(0.9, 1, t).toFixed(3)})`;
          element.style.opacity = String(t);
        } else if (kind === "gather" && wide) {
          element.style.transform = `translate(${(x * (1 - t)).toFixed(1)}px, ${(fromY * (1 - t)).toFixed(1)}px)`;
        }
      }
    };

    let frame = 0;
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };
    const onResize = () => {
      measure();
      draw();
    };
    measure();
    draw();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("load", onResize);
    void document.fonts?.ready.then(onResize);

    // Boucles vidéo : chargées à l'approche de l'écran, lues tant qu'elles y sont.
    const loops = all<HTMLVideoElement>("video[data-home-loop]");
    const onPlaying = (event: Event) => {
      (event.currentTarget as HTMLVideoElement).dataset.playing = "";
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const video = entry.target as HTMLVideoElement;
                if (!entry.isIntersecting) {
                  video.pause();
                  continue;
                }
                if (!video.src && video.dataset.src) video.src = video.dataset.src;
                void video.play().catch(() => undefined);
              }
            },
            { rootMargin: "200px 0px" },
          );
    for (const video of loops) {
      video.addEventListener("playing", onPlaying);
      observer?.observe(video);
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("load", onResize);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      for (const video of loops) {
        video.removeEventListener("playing", onPlaying);
        video.pause();
        delete video.dataset.playing;
      }
      delete root.dataset.homeScenes;
      root.style.removeProperty("--home-dossier-scroll");
      root.style.removeProperty("--home-closing-scroll");
      // Seuls les styles posés ici sont retirés : les éléments gardent leur place (`--x`, `--y`).
      const reset = (element: HTMLElement | null) => {
        if (!element) return;
        element.style.transform = "";
        element.style.opacity = "";
        element.style.pointerEvents = "";
      };
      [heroCopy, grow, growOne, growTwo, ...lines].forEach(reset);
      for (const { element } of fliers) reset(element);
      for (const { element } of effects) {
        reset(element);
        reset(element.firstElementChild as HTMLElement | null);
      }
    };
  }, [reducedMotion]);
  return null;
}
