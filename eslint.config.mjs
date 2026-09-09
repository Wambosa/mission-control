import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "artifacts/**",
      "build/**",
      "dist/**",
      "dist-electron/**",
      "dist-electron-out/**",
      "node_modules/**",
      "publish/**",
      "test-results/**",
      "src/routeTree.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-undef": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "warn",
      "prefer-const": "off",
      "preserve-caught-error": "off",
      "react/no-danger": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["electron/**/*.ts", "scripts/**/*.mjs", "vite*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Session scaffolding runs against the session's working directory, which
    // may sit under a macOS-protected location. A synchronous filesystem call
    // there parks the Electron main thread behind a consent prompt that has no
    // timeout — the freeze this module set exists to remove. Asynchronous calls
    // are not free either (they hold a libuv pool thread), which is why the
    // caller probes the directory first; this rule only stops the worse of the
    // two from being reintroduced by the next scaffolding helper.
    //
    // The real filesystem lives behind `ScaffoldingFs`; add operations there
    // rather than reaching for `node:fs` here.
    files: [
      "electron/session-scaffolding.ts",
      "electron/ensure-diagram-skill.ts",
      "electron/ensure-recall-skill.ts",
      "electron/ensure-recall-mcp.ts",
      "electron/agent-memory-brief.ts",
      "src/shared/agent-memory-file.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression > Identifier.property[name=/Sync$/]",
          message:
            "Synchronous filesystem calls are banned in session-scaffolding code — they run against the session cwd and can freeze the main process behind a macOS consent prompt. Use the injected ScaffoldingFs.",
        },
        {
          selector: "ImportDeclaration[source.value='node:fs']",
          message:
            "Import the injected ScaffoldingFs instead of node:fs here; node:fs/promises is available for the module's own default implementation.",
        },
        {
          selector: "ImportDeclaration[source.value='fs']",
          message:
            "Import the injected ScaffoldingFs instead of fs here; node:fs/promises is available for the module's own default implementation.",
        },
      ],
    },
  },
);
