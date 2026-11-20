import {
  BoxGeometry,
  CylinderGeometry,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Shape,
  type BufferGeometry,
  type Material,
} from "three";
import type { MaquetteKind } from "@/lib/sale-maquette";

/**
 * Volumes schématiques de la maquette : un par type de bien, à la manière d'une maquette
 * d'architecte. Le bien vendu est cerné d'or (le lot dans l'immeuble, l'immeuble entier, la parcelle
 * de la maison ou du terrain). Rien n'est tiré de l'annonce : ni forme, ni étage, ni voisinage.
 */
export type MaquetteMaterials = {
  wall: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  roof: MeshStandardMaterial;
  wood: MeshStandardMaterial;
  /** Vitrages : leur émission suit l'heure (fenêtres éclairées à la nuit tombée). */
  glass: MeshStandardMaterial;
  grass: MeshStandardMaterial;
  foliage: MeshStandardMaterial;
  trunk: MeshStandardMaterial;
  /** Couleur d'accent : ce qui est vendu. */
  accent: MeshStandardMaterial;
  accentVeil: MeshStandardMaterial;
  accentLine: LineBasicMaterial;
};

export function createMaquetteMaterials(accent: string): MaquetteMaterials {
  const matte = (color: number, roughness = 0.9) => new MeshStandardMaterial({ color, roughness });
  return {
    wall: matte(0xfbf8f2, 0.85),
    stone: matte(0xddd5c8),
    roof: matte(0x7d8794, 0.7),
    wood: matte(0x8a6a4a, 0.8),
    glass: new MeshStandardMaterial({
      color: 0x5b7896,
      roughness: 0.2,
      metalness: 0.3,
      emissive: 0xffc98a,
      emissiveIntensity: 0,
    }),
    grass: matte(0xb9d19a, 1),
    foliage: matte(0x93b47c, 1),
    trunk: matte(0x7a6652, 1),
    accent: new MeshStandardMaterial({ color: accent, roughness: 0.55 }),
    accentVeil: new MeshStandardMaterial({
      color: accent,
      roughness: 0.6,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }),
    accentLine: new LineBasicMaterial({ color: accent }),
  };
}

/** Boîte posée sur le sol : `y` est la hauteur de sa base. */
export function box(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  material: Material,
): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.position.set(at[0], at[1] + size[1] / 2, at[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Position d'un exemplaire, avec une échelle facultative. */
type Place = readonly [x: number, y: number, z: number, scale?: number];

/** Une même géométrie posée à plusieurs endroits, en un seul appel de dessin. */
function repeated(
  geometry: BufferGeometry,
  material: Material,
  places: ReadonlyArray<Place>,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, places.length);
  const matrix = new Matrix4();
  places.forEach(([x, y, z, scale = 1], index) =>
    mesh.setMatrixAt(index, matrix.makeScale(scale, scale, scale).setPosition(x, y, z)),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Ce qui est vendu, quand c'est un volume : ses arêtes d'or, et un voile d'or quand il faut le
 * distinguer du reste (un lot dans l'immeuble).
 */
function soldVolume(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  m: MaquetteMaterials,
  veiled: boolean,
): Group {
  const group = new Group();
  const geometry = new BoxGeometry(...size);
  group.add(new LineSegments(new EdgesGeometry(geometry), m.accentLine));
  if (veiled) group.add(new Mesh(geometry, m.accentVeil));
  group.position.set(at[0], at[1] + size[1] / 2, at[2]);
  return group;
}

/** Ce qui est vendu, quand c'est une parcelle : un liseré d'or et une borne à chaque angle. */
function soldParcel(width: number, depth: number, m: MaquetteMaterials): Group {
  const group = new Group();
  const [w, d, edge] = [width / 2, depth / 2, 0.16];
  group.add(
    box([width + edge, 0.22, edge], [0, 0, d], m.accent),
    box([width + edge, 0.22, edge], [0, 0, -d], m.accent),
    box([edge, 0.22, depth + edge], [w, 0, 0], m.accent),
    box([edge, 0.22, depth + edge], [-w, 0, 0], m.accent),
  );
  const stake = new CylinderGeometry(0.11, 0.11, 0.9, 10).translate(0, 0.45, 0);
  group.add(
    repeated(stake, m.accent, [
      [w, 0, d],
      [w, 0, -d],
      [-w, 0, d],
      [-w, 0, -d],
    ]),
  );
  return group;
}

/** Arbres de maquette : un tronc et une boule de feuillage, en deux appels de dessin. */
export function trees(places: ReadonlyArray<Place>, m: MaquetteMaterials): Group {
  const group = new Group();
  const trunk = new CylinderGeometry(0.12, 0.16, 1.5, 8).translate(0, 0.75, 0);
  const crown = new IcosahedronGeometry(1.05, 1).translate(0, 2.3, 0);
  group.add(repeated(trunk, m.trunk, places), repeated(crown, m.foliage, places));
  return group;
}

const FLOORS = 4;
const GROUND_FLOOR = 3.1;
const FLOOR = 2.7;
const [BUILDING_WIDTH, BUILDING_DEPTH] = [9, 7];

/** Immeuble de ville : rez-de-chaussée en pierre, quatre étages, toit-terrasse. */
function building(kind: "apartment" | "building", m: MaquetteMaterials): Group {
  const group = new Group();
  const height = GROUND_FLOOR + FLOORS * FLOOR;
  const [w, d] = [BUILDING_WIDTH / 2, BUILDING_DEPTH / 2];
  group.add(
    box([BUILDING_WIDTH, height, BUILDING_DEPTH], [0, 0, 0], m.wall),
    box([BUILDING_WIDTH + 0.2, GROUND_FLOOR, BUILDING_DEPTH + 0.2], [0, 0, 0], m.stone),
    // Toit-terrasse : acrotère, édicule de l'escalier.
    box([BUILDING_WIDTH + 0.3, 0.45, BUILDING_DEPTH + 0.3], [0, height, 0], m.stone),
    box([BUILDING_WIDTH - 0.5, 0.2, BUILDING_DEPTH - 0.5], [0, height + 0.3, 0], m.roof),
    box([2.2, 1.5, 2], [-2, height + 0.4, -1], m.wall),
    // Rez-de-chaussée : porte et vitrines.
    box([1.3, 2.3, 0.14], [0, 0, d + 0.1], m.wood),
    box([2.4, 1.9, 0.12], [-2.7, 0.5, d + 0.1], m.glass),
    box([2.4, 1.9, 0.12], [2.7, 0.5, d + 0.1], m.glass),
  );
  const bands: Array<readonly [number, number, number]> = [];
  const windows: Array<readonly [number, number, number]> = [];
  const sideWindows: Array<readonly [number, number, number]> = [];
  const balconies: Array<readonly [number, number, number]> = [];
  for (let floor = 0; floor < FLOORS; floor += 1) {
    const base = GROUND_FLOOR + floor * FLOOR;
    bands.push([0, base, 0]);
    for (const x of [-3.15, -1.05, 1.05, 3.15]) {
      windows.push([x, base + 0.75, d], [x, base + 0.75, -d]);
    }
    for (const z of [-1.7, 1.7]) sideWindows.push([w, base + 0.75, z], [-w, base + 0.75, z]);
    balconies.push([-1.05, base + 0.1, d + 0.45], [1.05, base + 0.1, d + 0.45]);
  }
  group.add(
    repeated(new BoxGeometry(BUILDING_WIDTH + 0.16, 0.14, BUILDING_DEPTH + 0.16), m.stone, bands),
    repeated(new BoxGeometry(1.1, 1.5, 0.14).translate(0, 0.75, 0), m.glass, windows),
    repeated(new BoxGeometry(0.14, 1.5, 1.1).translate(0, 0.75, 0), m.glass, sideWindows),
    repeated(new BoxGeometry(1.7, 0.12, 0.9), m.stone, balconies),
    repeated(new BoxGeometry(1.7, 0.55, 0.05).translate(0, 0.33, 0.42), m.stone, balconies),
  );
  group.add(
    kind === "building"
      ? soldVolume([BUILDING_WIDTH + 0.5, height + 0.5, BUILDING_DEPTH + 0.5], [0, 0, 0], m, false)
      : // Un lot parmi d'autres : la moitié droite d'un étage, sans dire lequel est le vrai.
        soldVolume(
          [BUILDING_WIDTH / 2 + 0.3, FLOOR, BUILDING_DEPTH + 0.5],
          [BUILDING_WIDTH / 4 + 0.1, GROUND_FLOOR + 2 * FLOOR, 0],
          m,
          true,
        ),
  );
  return group;
}

/** Toit à deux pans : un prisme dont le faîtage suit la largeur. */
function gableRoof(width: number, rise: number, depth: number): ExtrudeGeometry {
  const half = depth / 2;
  const profile = new Shape().moveTo(-half, 0).lineTo(half, 0).lineTo(0, rise).closePath();
  return new ExtrudeGeometry(profile, { depth: width, bevelEnabled: false })
    .translate(0, 0, -width / 2)
    .rotateY(Math.PI / 2);
}

/** Maison individuelle sur sa parcelle : toit à deux pans, garage accolé, haie et allée. */
function house(m: MaquetteMaterials): Group {
  const group = new Group();
  const [lotWidth, lotDepth] = [16, 13];
  const roof = new Mesh(gableRoof(8.8, 2.5, 7), m.roof);
  roof.position.set(-1.5, 3.32, -1);
  roof.castShadow = true;
  roof.receiveShadow = true;
  group.add(
    box([lotWidth, 0.12, lotDepth], [0, 0, 0], m.grass),
    box([8, 3.2, 6], [-1.5, 0.12, -1], m.wall),
    roof,
    box([0.7, 1.6, 0.7], [-3.6, 4.4, -1.8], m.stone),
    // Garage accolé, toit plat.
    box([3.6, 2.6, 5], [4.3, 0.12, -1.3], m.wall),
    box([3.9, 0.2, 5.3], [4.3, 2.72, -1.3], m.roof),
    box([2.6, 2, 0.12], [4.3, 0.12, 1.22], m.stone),
    // Façade : porte, fenêtres, allée jusqu'à la rue.
    box([1, 2.1, 0.12], [-1.5, 0.12, 2.04], m.wood),
    box([1.5, 1.3, 0.12], [-4, 1.1, 2.04], m.glass),
    box([1.5, 1.3, 0.12], [1, 1.1, 2.04], m.glass),
    box([0.12, 1.3, 1.5], [-5.54, 1.1, -1], m.glass),
    box([1.4, 0.06, 4.4], [-1.5, 0.12, 4.3], m.stone),
    box([2.6, 0.06, 5.2], [4.3, 0.12, 3.9], m.stone),
    // Haie sur les trois côtés qui ne donnent pas sur la rue.
    box([lotWidth - 0.6, 0.9, 0.5], [0, 0.12, -lotDepth / 2 + 0.45], m.foliage),
    box([0.5, 0.9, lotDepth - 1.2], [-lotWidth / 2 + 0.45, 0.12, 0], m.foliage),
    box([0.5, 0.9, lotDepth - 1.2], [lotWidth / 2 - 0.45, 0.12, 0], m.foliage),
    trees(
      [
        [-6, 0.12, 4],
        [6.3, 0.12, -4.6],
      ],
      m,
    ),
    soldParcel(lotWidth, lotDepth, m),
  );
  return group;
}

/** Terrain nu : une parcelle enherbée, bornée, avec quelques arbres en lisière. */
function land(m: MaquetteMaterials): Group {
  const group = new Group();
  const [lotWidth, lotDepth] = [15, 11.5];
  group.add(
    box([lotWidth, 0.14, lotDepth], [0, 0, 0], m.grass),
    trees(
      [
        [-5.6, 0.14, -3.8],
        [-3.4, 0.14, -4.3],
        [5.4, 0.14, -3.2],
        [5.9, 0.14, 3.6],
      ],
      m,
    ),
    soldParcel(lotWidth, lotDepth, m),
  );
  return group;
}

export function maquetteModel(kind: MaquetteKind, m: MaquetteMaterials): Group {
  if (kind === "house") return house(m);
  if (kind === "land") return land(m);
  return building(kind, m);
}
