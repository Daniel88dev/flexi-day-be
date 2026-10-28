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
      "lambda/**/dist/**",
      ".claude/**",
      "node_modules/**",
      "coverage/**",
      "build/**",
      ".turbo/**",
      "drizzle.config.ts",
      "eslint.config.js",
      "vitest.config.ts",
      "vitest.e2e.config.ts",
      "**/tests/**",
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
  },

  // 2) Base JS rules
  js.configs.recommended,

  // 3) TypeScript rules with type-aware linting
  ...tseslint.configs.recommendedTypeChecked,

  // 3b) Plain JS/MJS is not in the tsconfig project, so the type-aware rules
  // cannot run on it and throw rather than skip. Standalone scripts still get
  // the base JS rules.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

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

      // Tune type-aware "unsafe" checks: allow but warn on unsafe assignment
      "@typescript-eslint/no-unsafe-assignment": "warn",

      // Console is useful on servers and in containers
      "no-console": "off",

      // Flags every `obj[key]`; typed keys already rule out what it guards against.
      "security/detect-object-injection": "off",
      "security/detect-non-literal-fs-filename": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },

  // The disk stores confine every key under their root (`keyToPath`), and the person export
  // writes only into its own `mkdtemp` folder. Disk access elsewhere still needs a look.
  {
    files: [
      "src/services/attachment/attachmentStore.ts",
      "src/services/organizationData/organizationDataStore.ts",
      "src/services/personExport/personExportArchive.ts",
      "src/services/personExport/personExportBuild.ts",
    ],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
];
