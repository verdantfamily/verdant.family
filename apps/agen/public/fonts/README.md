# Drop Aeonik here

The page is set in Aeonik. Aeonik is licensed, so no copy is committed to this
repository — put yours in this folder, under exactly these names:

```
Aeonik-Regular.woff2      (or Aeonik-Regular.otf)
Aeonik-Medium.woff2       (or Aeonik-Medium.otf)
Aeonik-Bold.woff2         (or Aeonik-Bold.otf, optional — nothing uses 700 today)
```

Either format works; both are declared. Prefer woff2 if you have it — roughly half the
bytes of an OTF, and this is the largest thing the page downloads.

That is the whole installation. There is no build step and no code to change: the
`@font-face` rules at the top of `src/app/globals.css` already point here. Reload and it
is Aeonik.

## What happens with the folder empty

Nothing breaks. A missing font file is a 404, and a 404 makes the browser fall through to
the next family in the stack — Inter Tight, loaded through `next/font`, which is the
closest neutral grotesk available under an open licence.

This is why the faces are declared as plain CSS instead of through `next/font/local`: a
`next/font/local` call names its files at build time and fails the build when they are
absent, so it cannot express "use these if they are there".

## Weights

Each weight is declared separately and `font-synthesis-weight` is off, so a partial drop
degrades honestly rather than faking what is missing. Supply only Regular and the
headline — which is 500 — stays in the fallback instead of rendering as a smeared
imitation medium.

If your licence only covers Regular, the fix is to change `.headline`'s `font-weight` to
400 rather than to let the browser invent one.

## After dropping them in

Have a look at the tracking. `letter-spacing` on `.headline` is `-0.032em`, and that
number is a correction for a specific face's default fit at that size, not a constant.
Aeonik is a little tighter than Inter Tight to begin with, so it will probably want
slightly less.
