import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat();

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // `next/image` exists to resize and lazy-load on a server. This is a static export
      // with two images, both supplied by hand at known sizes, so it would add a component
      // and a config flag in exchange for nothing.
      "@next/next/no-img-element": "off",
    },
  },
  {
    ignores: [".next/**", "out/**", "next-env.d.ts"],
  },
];
