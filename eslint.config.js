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
      "**/.venv/**",
      ".output",
      ".nitro",
      ".next",
      ".tanstack",
      ".vercel",
      ".vinxi",
      "supabase/.temp",
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
  eslintPluginPrettier,
);
