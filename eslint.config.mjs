import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([globalIgnores(["bin/", "lib/"]), {
  extends: compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended", // uses the recommended rules from the @typescript-eslint/eslint-plugin
  ),

  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2018,
    sourceType: "module",
  },

  rules: {
    quotes: ["error", "double"],
    indent: ["error", 2, {
      SwitchCase: 1,
    }],
    "linebreak-style": ["error", "unix"],
    semi: ["error", "always"],
    "comma-dangle": ["error", "always-multiline"],
    "dot-notation": "error",
    eqeqeq: "error",
    curly: ["error", "all"],
    "brace-style": ["error"],
    "prefer-arrow-callback": "warn",
    "max-len": ["warn", 180],
    "@typescript-eslint/no-unused-vars": ["error", {
      caughtErrors: "none",
    }],
    // `@typescript-eslint/camelcase` used to be turned off here, because dns-packet
    // names a lot of things that way. The rule was removed from the plugin back in
    // v5, and flat config rejects a rule the plugin does not define, so the entry
    // has gone rather than being carried across.
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-use-before-define": ["error", {
      classes: false,
    }],
  },
}]);
