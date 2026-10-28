import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cohérence des versions épinglées à plusieurs endroits (audit du 27/10/2026, n° 85) :
 *  - Node : `.nvmrc`, `.node-version` et la borne basse de `engines.node` de `package.json` sont identiques, la borne
 *    haute est la version majeure suivante ; tout `node-version:` écrit en clair dans un workflow est la même version
 *    (les workflows lisent d'ordinaire `.node-version`) ;
 *  - npm : la borne basse de `engines.npm` est la version épinglée par chaque `npm install --global npm@X` des
 *    workflows et par la commande d'installation de `vercel.json` ; la borne haute est la majeure suivante ;
 *  - Playwright : la version de l'image du conteneur de l'étape `e2e` de `ci.yml`
 *    (`mcr.microsoft.com/playwright:vX.Y.Z-…`) est celle de `@playwright/test` (`package.json` et lockfile). Une
 *    montée de `@playwright/test` par Dependabot sans l'image rendrait `e2e` rouge sans cause évidente.
 *
 * Aucune dépendance, aucun accès réseau : `npm run check:versions` (CI, job « invariant collecte unique »).
 */

const NODE_RANGE = /^>=\s*(\d+\.\d+\.\d+)\s*<\s*(\d+)(?:\.\d+\.\d+)?$/;

async function readText(root, relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function readOptional(root, relativePath) {
  try {
    return await readText(root, relativePath);
  } catch {
    return null;
  }
}

function major(version) {
  return Number(String(version).split(".")[0]);
}

/** « v24.15.0 » ou « 24.15.0 » en « 24.15.0 ». */
function plainVersion(text) {
  return text.trim().replace(/^v/, "");
}

/** Les problèmes trouvés, un message par ligne ; liste vide quand tout concorde. */
export async function checkVersions({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
  const problems = [];

  const packageJson = JSON.parse(await readText(root, "package.json"));
  const nvmrc = await readOptional(root, ".nvmrc");
  const nodeVersionFile = await readOptional(root, ".node-version");
  const vercelJson = await readOptional(root, "vercel.json");

  // Node -----------------------------------------------------------------------------------------------
  const nodeVersion = nvmrc ? plainVersion(nvmrc) : null;
  if (!nodeVersion) problems.push(".nvmrc est absent ou vide.");
  if (!nodeVersionFile) problems.push(".node-version est absent ou vide.");
  if (nodeVersion && nodeVersionFile && plainVersion(nodeVersionFile) !== nodeVersion) {
    problems.push(
      `.node-version (${plainVersion(nodeVersionFile)}) et .nvmrc (${nodeVersion}) diffèrent.`,
    );
  }
  const nodeRange = NODE_RANGE.exec(String(packageJson.engines?.node ?? "").trim());
  if (!nodeRange) {
    problems.push(
      `package.json engines.node (${packageJson.engines?.node ?? "absent"}) n'a pas la forme ">=X.Y.Z <M".`,
    );
  } else if (nodeVersion) {
    if (nodeRange[1] !== nodeVersion) {
      problems.push(
        `package.json engines.node commence à ${nodeRange[1]} mais .nvmrc épingle ${nodeVersion}.`,
      );
    }
    if (Number(nodeRange[2]) !== major(nodeVersion) + 1) {
      problems.push(
        `package.json engines.node s'arrête à la version majeure ${nodeRange[2]} au lieu de ${major(nodeVersion) + 1}.`,
      );
    }
  }

  // npm ------------------------------------------------------------------------------------------------
  const npmRange = NODE_RANGE.exec(String(packageJson.engines?.npm ?? "").trim());
  let npmVersion = null;
  if (!npmRange) {
    problems.push(
      `package.json engines.npm (${packageJson.engines?.npm ?? "absent"}) n'a pas la forme ">=X.Y.Z <M".`,
    );
  } else {
    npmVersion = npmRange[1];
    if (Number(npmRange[2]) !== major(npmVersion) + 1) {
      problems.push(
        `package.json engines.npm s'arrête à la version majeure ${npmRange[2]} au lieu de ${major(npmVersion) + 1}.`,
      );
    }
  }

  // Workflows ------------------------------------------------------------------------------------------
  const workflowsDirectory = path.join(root, ".github", "workflows");
  const workflowFiles = (await readdir(workflowsDirectory).catch(() => []))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  let npmPins = 0;
  for (const name of workflowFiles) {
    const text = await readText(root, path.join(".github", "workflows", name));
    for (const match of text.matchAll(/npm@(\d+\.\d+\.\d+)/g)) {
      npmPins += 1;
      if (npmVersion && match[1] !== npmVersion) {
        problems.push(
          `${name} épingle npm@${match[1]} alors que engines.npm commence à ${npmVersion}.`,
        );
      }
    }
    for (const match of text.matchAll(
      /^\s*node-version:\s*["']?v?(\d+(?:\.\d+){0,2})["']?\s*$/gm,
    )) {
      if (nodeVersion && match[1] !== nodeVersion) {
        problems.push(
          `${name} épingle node-version ${match[1]} alors que .nvmrc épingle ${nodeVersion}.`,
        );
      }
    }
  }
  if (workflowFiles.length > 0 && npmPins === 0) {
    problems.push(
      "Aucun workflow n'épingle npm@X.Y.Z : le contrôle de version npm ne porte sur rien.",
    );
  }

  // Vercel ---------------------------------------------------------------------------------------------
  if (vercelJson) {
    const installCommand = String(JSON.parse(vercelJson).installCommand ?? "");
    const pins = [...installCommand.matchAll(/npm@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
    if (pins.length === 0) {
      problems.push("vercel.json installCommand n'épingle pas npm@X.Y.Z.");
    } else if (npmVersion && pins.some((pin) => pin !== npmVersion)) {
      problems.push(
        `vercel.json installCommand épingle npm@${pins.join(", npm@")} alors que engines.npm commence à ${npmVersion}.`,
      );
    }
  }

  // Playwright : l'image du conteneur de ci.yml et @playwright/test ---------------------------------------
  const ci = await readOptional(root, path.join(".github", "workflows", "ci.yml"));
  const declared = String(
    packageJson.devDependencies?.["@playwright/test"] ??
      packageJson.dependencies?.["@playwright/test"] ??
      "",
  ).replace(/^[\^~]/, "");
  if (ci && declared) {
    const image = /image:\s*mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)[^\s]*/.exec(ci);
    if (!image) {
      problems.push("ci.yml ne lance plus e2e dans l'image mcr.microsoft.com/playwright:vX.Y.Z.");
    } else if (image[1] !== declared) {
      problems.push(
        `ci.yml lance e2e dans l'image Playwright v${image[1]} alors que @playwright/test vaut ${declared} : monter l'image (étiquette et empreinte) avec le paquet.`,
      );
    }
    const lock = await readOptional(root, "package-lock.json");
    if (lock) {
      const locked = JSON.parse(lock).packages?.["node_modules/@playwright/test"]?.version;
      if (locked && locked !== declared) {
        problems.push(
          `package-lock.json installe @playwright/test ${locked} alors que package.json demande ${declared}.`,
        );
      }
    }
  }

  return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problems = await checkVersions();
  if (problems.length > 0) {
    console.error(JSON.stringify({ ok: false, problems }, null, 2));
    process.exitCode = 1;
  } else {
    console.info(JSON.stringify({ ok: true }));
  }
}
