import eslint from "@eslint/js";
import stylisticPlugin from "@stylistic/eslint-plugin";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/.next-*/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/.runtime/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@stylistic": stylisticPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      curly: ["error", "all"],
      eqeqeq: "error",
      "no-console": ["warn", { allow: ["debug", "error"] }],
      "no-unused-expressions": "off",
      "object-shorthand": "error",
      "prefer-const": "error",

      "@stylistic/brace-style": ["error", "1tbs"],
      "@stylistic/member-delimiter-style": [
        "error",
        {
          multiline: {
            delimiter: "semi",
            requireLast: true,
          },
          singleline: {
            delimiter: "semi",
            requireLast: false,
          },
        },
      ],

      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-member-accessibility": [
        "error",
        {
          accessibility: "explicit",
          overrides: {
            accessors: "explicit",
            constructors: "no-public",
            methods: "explicit",
            properties: "off",
            parameterProperties: "explicit",
          },
        },
      ],
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-var-requires": "off",

      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prettier/prettier": "error",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    rules: {
      "@typescript-eslint/explicit-member-accessibility": "off",
    },
  },
);
