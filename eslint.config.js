// eslint.config.js (Flat config for ESLint v9)
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import securityPlugin from "eslint-plugin-security";
import globals from "globals";

export default [
  // 1) Ignore generated and vendor folders
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "build/**",
      ".turbo/**",
      "drizzle.config.ts",
      "eslint.config.js",
      "vitest.config.ts",
      "src/tests/**"
    ],
  },

  // 2) Base JS rules
  js.configs.recommended,

  // 3) TypeScript rules with type-aware linting
  ...tseslint.configs.recommendedTypeChecked,

  // 4) Project-specific config
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    plugins: {
      security: securityPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware rules require your tsconfig
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Be pragmatic about unused vars; allow leading underscore to intentionally ignore
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // If your codebase sometimes needs any (e.g., external schema/validation), lower severity
      "@typescript-eslint/no-explicit-any": "warn",

      // Console is useful on servers and in containers
      "no-console": "off",

      // Security plugin: keep useful checks but avoid noisy false positives
      "security/detect-object-injection": "warn",
      "security/detect-non-literal-fs-filename": "warn",
    },
  },
];
