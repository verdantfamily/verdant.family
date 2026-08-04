# Brand files

Every image here is generated, and generated somewhere else. Do not edit them, and do not
drop replacements in this folder: it is overwritten. Put the originals in
`apps/landing/brand-source/` and run

```bash
pnpm --filter @verdant/landing brand
```

which writes the same five files into both `apps/landing/public/brand/` and this folder.

The generator lives with the teaser rather than here because that is where the sources and
the one dependency heavy enough to matter — sharp — already are. It writes to both apps
because a Next application can only serve static files from its own `public/`, and a copy
step performed by hand is how the launchpad ends up wearing last month's logo: it fails
silently, it fails in only one of the two apps, and neither app looks wrong enough for
anyone to check. `apps/landing/scripts/prepare-brand.ts` explains what each file is cut
from and why.

| File | What the launchpad does with it |
|---|---|
| `mark.png` | The mark in the header, beside the wordmark. Absent, the header draws a sprout instead |
| `logo.png` | The lockup, used only if there is no separate mark |
| `bg.jpg` | The full-bleed photograph under every page, shown unmodified — tables stay readable because the surfaces over it are translucent above a backdrop blur |
| `favicon.png` | The tab icon |
| `og.jpg` | Generated for the teaser's link card; the launchpad does not reference it yet |

`src/lib/brand.ts` resolves these by name and returns `null` for anything missing, so a
clone that has never run the generator renders a drawn mark on the canvas colour rather
than a page of broken images.
