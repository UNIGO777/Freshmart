import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**", "build/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    rules: {
      // Allow intentionally-unused args/vars prefixed with `_` (e.g. the
      // Express error-handler `_next` signature, throwaway destructures).
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
        global: "readonly",
        // Node.js global timers & web-standard globals available in Node
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        AbortController: "readonly"
      }
    }
  }
];
