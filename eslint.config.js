import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "build",
      "coverage",
      "test-results",
      "playwright-report",
      "output",
      ".playwright-cli",
      "node_modules",
      // Paquet construit du traitement d'inondation pour GitHub Actions (npm run flood-risk:build).
      ".flood-risk-runner",
      "**/.venv/**",
      ".output",
      ".nitro",
      ".next",
      ".tanstack",
      ".vercel",
      ".vinxi",
      "supabase/.temp",
      ".claude/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Système visuel : les couleurs passent par les jetons de src/styles.css
    // (text-brand-navy, bg-surface-tint, border-line…), jamais par text-[#hex].
    files: ["src/**/*.{ts,tsx}", "emails/**/*.tsx"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/-\\[#[0-9a-fA-F]{3,8}\\]/]",
          message:
            "Couleur codée en dur dans une classe : utilisez un jeton (text-brand-navy, bg-surface-tint, border-line…) défini dans src/styles.css.",
        },
        {
          selector: "TemplateElement[value.raw=/-\\[#[0-9a-fA-F]{3,8}\\]/]",
          message:
            "Couleur codée en dur dans une classe : utilisez un jeton (text-brand-navy, bg-surface-tint, border-line…) défini dans src/styles.css.",
        },
      ],
    },
  },
  {
    // Couches : `src/lib` est la logique pure, que les composants et les routes appellent. Elle
    // n'importe jamais l'interface (`@/components`) ni les routes (`@/app`), sinon un module de
    // calcul embarque du React ou du code de page et le sens des dépendances s'inverse.
    files: ["src/lib/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/components",
                "@/components/**",
                "@/app",
                "@/app/**",
                "../components",
                "../components/**",
                "../../components/**",
                "../app",
                "../app/**",
                "../../app/**",
              ],
              message:
                "src/lib n'importe pas l'interface (@/components) ni les routes (@/app) : déplacez le module partagé dans src/lib.",
            },
          ],
        },
      ],
    },
  },
  {
    // Exemption connue (lot 4a, n° 77) : `department-pages.ts` lit la liste des départements dans
    // `@/components/fees-simulator/departments`, une donnée pure que quatre composants partagent aussi.
    // À retirer quand cette liste sera déplacée dans `src/lib` (cinq fichiers à adapter).
    files: ["src/lib/department-pages.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  eslintPluginPrettier,
);
