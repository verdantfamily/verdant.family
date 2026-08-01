# Brand files

Every image in this folder is generated. Do not edit them and do not drop replacements here
directly — put the originals in `apps/landing/brand-source/` and run:

```bash
pnpm --filter @verdant/landing brand
```

| Generated | From | What it becomes |
|---|---|---|
| `mark.png` | the mark half of `logo.png` | The mark at the top of the page |
| `logo.png` | `logo.png`, cropped to its ink | The full lockup, used on the link card and as the page's fallback if there is no separate mark |
| `bg.jpg` | `bg.jpg`, resized and blurred | The full-bleed background |
| `og.jpg` | both | The image X, iMessage and Slack show when the link is pasted |
| `favicon.png` | the mark, on a filled plate | The tab icon |

## What the script does, and why it is not manual

Originals are the wrong shape for the web in ways that are easy to miss until someone opens
the page on a phone:

- **The photograph** arrived as 13 MB at 4496 × 3000. It ships at 1920 px and 20 KB, blurred
  during the resize rather than by CSS — the browser is then drawing an ordinary image
  instead of convolving a full-screen layer on every animated frame.
- **The logo** is a lockup on a 976 × 233 canvas with the mark in the left sixth. Centring
  that file centres the canvas, so the mark lands off to one side. The script finds the ink,
  finds the gap between mark and wordmark, and cuts them apart.
- **The favicon** has to sit on a filled plate. The mark is white, and white on transparency
  is invisible in a light tab strip.

The run prints the photograph's mean colour. That value belongs in `--void` in
`src/app/globals.css` and in `themeColor` in `src/app/layout.tsx`, and it is what the page
paints before the photograph loads.

## Replacing something

Names in `brand-source/` that the script looks for: `bg.jpg` (or `.jpeg`, or
`background.jpg`) and `logo.png`. A logo that is only a mark, with no wordmark, works too —
the script finds no gap wide enough to split at, says so, and the page uses the whole thing.

Anything else in `brand-source/` is ignored, which is deliberate: a build that guesses which
of five images is the logo will eventually guess wrong.

## Sizes worth having

The background at 2560 px wide or more (it is rendered `cover`, so it is cropped rather than
letterboxed) and the logo at 400 px tall or more. Both are downsampled, and downsampling is
the only direction that looks good.
