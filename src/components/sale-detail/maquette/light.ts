/**
 * Lumière de la maquette selon l'heure choisie par le visiteur. Elle est indicative : l'orientation
 * réelle du bien n'est pas connue, le soleil tourne autour d'un volume schématique.
 */
export const MAQUETTE_HOURS = { min: 6, max: 21, step: 0.5, initial: 10 } as const;

export type MaquetteLight = {
  /** Couleurs du ciel, en 0xRRGGBB. */
  zenith: number;
  horizon: number;
  sunColor: number;
  sunIntensity: number;
  ambientIntensity: number;
  /** Direction du soleil vue depuis le sol (vecteur unitaire, y vers le haut). */
  sunDirection: readonly [number, number, number];
  /** Fenêtres éclairées, de 0 (jour) à 1 (nuit tombée). */
  windowGlow: number;
};

type Keyframe = Omit<MaquetteLight, "sunDirection">;

// Du lever au coucher : aube rosée, plein jour, fin d'après-midi dorée, crépuscule, nuit tombée.
const KEYFRAMES: ReadonlyArray<Keyframe & { hour: number }> = [
  {
    hour: 6,
    zenith: 0x40557f,
    horizon: 0xf0b790,
    sunColor: 0xffd2b0,
    sunIntensity: 1.3,
    ambientIntensity: 0.55,
    windowGlow: 0.6,
  },
  {
    hour: 8,
    zenith: 0x6fa3d8,
    horizon: 0xf4dfc8,
    sunColor: 0xffeedb,
    sunIntensity: 2.5,
    ambientIntensity: 0.8,
    windowGlow: 0,
  },
  {
    hour: 12.5,
    zenith: 0x4f97e0,
    horizon: 0xdcebf7,
    sunColor: 0xfffaf2,
    sunIntensity: 3.2,
    ambientIntensity: 1,
    windowGlow: 0,
  },
  {
    hour: 17,
    zenith: 0x5a94d6,
    horizon: 0xf3e2c8,
    sunColor: 0xfff0dc,
    sunIntensity: 2.7,
    ambientIntensity: 0.85,
    windowGlow: 0,
  },
  {
    hour: 19.5,
    zenith: 0x4a5f96,
    horizon: 0xf2aa7c,
    sunColor: 0xffc49a,
    sunIntensity: 1.6,
    ambientIntensity: 0.6,
    windowGlow: 0.7,
  },
  {
    hour: 21,
    zenith: 0x141f3a,
    horizon: 0x3f4c70,
    sunColor: 0xb4c2e6,
    sunIntensity: 0.55,
    ambientIntensity: 0.4,
    windowGlow: 1,
  },
];

const mix = (from: number, to: number, t: number) => from + (to - from) * t;

function mixColor(from: number, to: number, t: number): number {
  const channel = (shift: number) =>
    Math.round(mix((from >> shift) & 0xff, (to >> shift) & 0xff, t)) << shift;
  return channel(16) | channel(8) | channel(0);
}

/** Lumière à `hour` (heure décimale), bornée à la plage du curseur. */
export function maquetteLight(hour: number): MaquetteLight {
  const h = Math.min(Math.max(hour, MAQUETTE_HOURS.min), MAQUETTE_HOURS.max);
  const next = KEYFRAMES.findIndex((key) => key.hour >= h);
  const to = KEYFRAMES[next];
  const from = KEYFRAMES[Math.max(next - 1, 0)];
  const t = to.hour === from.hour ? 0 : (h - from.hour) / (to.hour - from.hour);
  // Course du soleil d'est (x > 0) en ouest, jamais sous 10° : une ombre rasante reste lisible.
  const course = ((h - MAQUETTE_HOURS.min) / (MAQUETTE_HOURS.max - MAQUETTE_HOURS.min)) * Math.PI;
  const x = Math.cos(course);
  const y = Math.max(Math.sin(course), 0.18);
  const z = 0.55;
  const length = Math.hypot(x, y, z);
  return {
    zenith: mixColor(from.zenith, to.zenith, t),
    horizon: mixColor(from.horizon, to.horizon, t),
    sunColor: mixColor(from.sunColor, to.sunColor, t),
    sunIntensity: mix(from.sunIntensity, to.sunIntensity, t),
    ambientIntensity: mix(from.ambientIntensity, to.ambientIntensity, t),
    sunDirection: [x / length, y / length, z / length],
    windowGlow: mix(from.windowGlow, to.windowGlow, t),
  };
}

/** « 10 h », « 14 h 30 » : l'heure du curseur, en clair. */
export function maquetteHourLabel(hour: number): string {
  const minutes = Math.round((hour % 1) * 60);
  return minutes ? `${Math.floor(hour)} h ${minutes}` : `${Math.floor(hour)} h`;
}
