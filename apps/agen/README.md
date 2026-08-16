# agen.space

The coming-soon page. One viewport, one headline, a date, and a chrome mark — no data
source, no wallet, no navigation, no client state. `next build` writes flat files into
`out/`, so it can be up long before anything it announces exists, and cannot break when
the indexer does.

Separate from `apps/landing`, which is verdant.family and stays as it is, and from
`apps/web`, which is the interface. Three deployments, on purpose: a page whose only job
is to exist should not be able to fail for anyone else's reason.

## Locally

```bash
pnpm --filter @verdant/agen dev        # http://localhost:3000
pnpm --filter @verdant/agen build      # writes out/
pnpm --filter @verdant/agen preview    # serves out/ at http://127.0.0.1:4321
pnpm --filter @verdant/agen brand      # regenerates mark.png, icon.png, the icons
```

## The typeface

The page is set in Aeonik, which is licensed and therefore not committed here. Drop the
files into `public/fonts/` — names and details in the README already sitting in that
folder — and the page uses them on the next load. No build step, no code change.

Until then it renders in Inter Tight, the nearest neutral grotesk available under an open
licence, and the layout was set against it rather than around it.

That "if they are there" behaviour is why Aeonik is declared as plain `@font-face` rules
in `globals.css` while the fallback goes through `next/font`: a `next/font/local` call
names its files at build time and fails the build when they are missing, whereas a font
file that 404s simply makes the browser fall through to the next family in the stack.

Once the real files are in, look at the tracking. `letter-spacing` on `.headline` is a
correction for one face's default fit at one size, not a constant.

## What is in it

`src/app/page.tsx` is the page and `src/app/globals.css` is the stylesheet. Both are
commented where the reasoning is not visible in the result.

The short version: black, with four stacked layers. Two enormous soft radial masses
drifting on `transform` and a very slow highlight sweep make the metal; a vignette drops
the corners so the centre reads as lit; the type sits above that; and a single tile of
generated grain goes over everything, type included, which is what stops it looking like
a dark website and starts it looking photographed.

Gradients rather than a render, because a gradient scaled past the viewport never
resolves into an object — it stays an edge of something — and a 3D asset announces its
own dimensions at every size.

The mark arrives as chrome on a black field, and `scripts/prepare-brand.ts` removes the
field by flooding inwards from the edges rather than by keying black: the artwork's own
outlines and the shadow in the curl of the shape are black too, so darkness reachable
from outside is background and darkness enclosed by the object is the object.

It used to sidestep that with `mix-blend-mode: screen`, under which black is nothing, and
that worked until it didn't — blending only reaches the nearest ancestor that creates a
stacking context, and the pointer parallax creates one, so the mark was blending against
the group it sits in rather than against the page. Its black field painted solid:
invisible on black, and a visible dark rectangle the moment the drifting light reached
the middle of a wide viewport. Real transparency doesn't depend on what happens to be
above it.

## The card and the icons

`pnpm --filter @verdant/agen brand` writes the four shipped icons from the one piece of
artwork in `brand-source/`.

The link card is not among them. It is `src/app/opengraph-image.tsx`, drawn per request at
1200 x 630 — exactly the 1.91:1 X crops to, so nothing is lost — from the front page's own
photograph and the front page's own headline, so a shared link looks like the thing it opens.
`/markets/[id]` overrides it with the token's own card; every other route inherits this one.

It is a route rather than a file for a reason worth keeping: the card used to be composited
into `public/og.jpg` by the brand script, which put the artwork in one place, the copy in an
SVG string inside a build step, and the cache-busting in a hand-bumped `?v=` counter in
`layout.tsx`. The result shipped a pre-launch teaser — "coming august 12" — for weeks after
launch, because nothing regenerated it and nothing pointed at it. Rendering it means the copy
sits beside the page's copy, the typeface is the real Aeonik rather than whatever Helvetica
sharp found on the machine, and Next hashes the URL from the content, so a changed card is a
changed address with no counter to remember.

Nothing in `layout.tsx` declares `openGraph.images`, deliberately: a config-declared array
beside a file-based card is two answers to one question, and the loser is invisible until
somebody shares a link.

`twitter:card` is `summary_large_image`. Without it X falls back to `summary`, which crops
the same image to a small square beside the text and discards the composition.

The icons are the mark on an opaque black plate, which it needs: the artwork is light grey
and light grey on transparency disappears into a light tab strip. Note that the plate is
composited rather than padded — `background` on a resize fills only the margin the resize
adds, so the transparency the keying pass cut out of the artwork stays transparent
underneath it, and the icon that results is a mark floating on whatever is behind it.

`favicon.ico` holds 16, 32 and 48 and is written by hand: it is a six-byte header and a
sixteen-byte record per image, the payload is allowed to be a PNG rather than the format's
original bitmap, and that is cheaper than a dependency. It exists because crawlers and
chat clients request `/favicon.ico` by path whatever the markup says. Small sizes get
almost no margin — spacing that reads as composure at 512 px reads as a shrunken mark
at 16.

The X link is the only interactive thing on the page, which is why it has a corner to
itself instead of a place in the footer. A row of social links would make this a website.

The two sentences type themselves, one character at a time, off a single counter — the
first line takes the first twenty-one characters and the second takes the rest, and the
only thing the clock does differently at the boundary is wait half a second. That pause is
the page: the first line is a statement of fact and the second is what makes it
frightening, and the gap is where the reader gets there on their own. Everything below
waits until both are finished.

The characters are all in the document from the first frame at zero opacity and are
revealed in place rather than being appended to a growing string — the lines are centred,
so a string that grows re-centres itself on every keystroke and re-breaks whenever a word
stops fitting. The cursor is a pseudo-element on the last revealed character, absolutely
positioned so it occupies no width and cannot push the line sideways as it travels.
Screen readers and crawlers get each sentence whole from an `sr-only` copy, because
forty-nine separately wrapped characters would otherwise be announced as forty-nine
things.

When the last character lands, the second line turns to chrome. Note that the gradient is
declared on each character rather than on the line, which is not a preference:
`background-clip: text` clips an element's background to its *own* rendered text, and
descendant spans are painted separately, so a gradient on the line clips to nothing and
the sentence vanishes. It is only equivalent because the angle is exactly vertical — every
character box shares a top and a bottom. Tilt it a few degrees and each letter gets its
own private sweep.

Without JavaScript both sentences are simply there, finished: they are server-rendered
complete and cleared on mount, before the browser paints.

The pointer writes two CSS variables and nothing else. The composition leans a few pixels
*against* the pointer while the masses behind it lean with it; opposing directions read as
perspective, matching ones read as a slide. It does nothing on touch, and nothing under
`prefers-reduced-motion` — which cancels every animation and puts the whole reveal in its
finished state, since those keyframes are `both`-filled and would otherwise leave the page
blank.

## Awareness

`lib/system.ts` is the only thing that decides what the page is currently saying. Idle
stages, the tab returning, the pointer leaving, the minute mark and the hover on the mark
all report into it, and it resolves them into a single `moment` by priority — so the page
can be interrupted but never talks over itself. `lib/ambient.ts` holds everything that is
allowed to happen *underneath* a moment, and it checks that the page is quiet first.
`lib/copy.ts` holds every line, so the writing can be read in one place without reading
the machinery.

The clock behind the silence is a quarter-second poll rather than a stack of timeouts
rebuilt on every mouse move, and it sets state only when the stage actually changes: four
renders over twenty-four seconds. It does not stop when the cursor leaves the window.
A cursor that has left is the strongest evidence there is that nobody is watching, and
pausing there would mean the page never reaches the dark for precisely the visitor it was
written for.

## On Vercel

Not yet deployed. The CLI is logged in on this machine but the stored token has expired —
the API answers `403 invalidToken` — so the first command below is not optional.
Everything up to the upload is done and verified.

Same arrangement as `apps/landing`: build here, upload the result. `apps/agen` has no
workspace dependencies, so Vercel *could* build it alone, but the lockfile is at the
repository root and an install that cannot see it resolves `^15.5.4` to whatever is
newest that morning. `--prebuilt` deploys the bytes that were actually looked at.

```bash
cd apps/agen
vercel login
vercel link                                  # new project, suggested name: agen
vercel env add NEXT_PUBLIC_SITE_URL production   # https://agen.space
vercel pull --yes --environment production
vercel build --prod
vercel deploy --prebuilt --prod
```

If `vercel build` gives trouble from inside the workspace, the fallback needs no build at
all: `out/` is already a finished static site, so `cd out && vercel link && vercel --prod`
uploads it as-is. Vercel finds no framework and no build command and simply serves the
files, which is all this page has ever needed. Set `NEXT_PUBLIC_SITE_URL` and re-run
`pnpm --filter @verdant/agen build` locally first — see the ordering note below.

Then attach `agen.space` in the dashboard. Note the ordering: `NEXT_PUBLIC_SITE_URL` is
compiled into `<head>`, so a deployment made before the domain existed keeps advertising
the wrong absolute URL for its link-card image until it is replaced. Set the variable,
then build.

If the repository gains a remote, connecting it is the better arrangement and Vercel
needs only to be told where the app is:

| Setting | Value |
|---|---|
| Root Directory | `apps/agen` |
| Framework preset | Next.js (detected) |
| Build command | `pnpm build` (default) |
| Output directory | `out` (detected from `output: "export"`) |
| Install command | `pnpm install` (default, runs at the repo root) |

No secrets, and no build-time network access beyond the font, which `next/font` fetches
once during the build and then serves from our own origin. Nothing here is tied to
Vercel — the same `out/` works on any static host.
