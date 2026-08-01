import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat();

/**
 * Next's own rules, plus the two this app needs held tighter than they come.
 *
 * `core-web-vitals` is included for the checks that catch real mistakes in an app that
 * renders on the server: a client component that did not need to be one, an image that
 * blocks paint, a link that triggers a full navigation.
 */
export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // An unused variable in a surface that renders money is usually a value that was
      // meant to be displayed and is not being. Underscore-prefixed names are exempt,
      // which is the escape hatch for a deliberately ignored destructured field.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `any` would silently defeat the one rule this app has: that amounts are
      // `bigint` from the API boundary onwards.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    ignores: [".next/**", "next-env.d.ts"],
  },
];
