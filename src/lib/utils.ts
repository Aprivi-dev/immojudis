import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `text-caption` est une taille de texte du thème (styles.css, --text-caption) : sans cette
// déclaration, tailwind-merge la prend pour une couleur et la retire devant `text-warning`.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["caption"] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
