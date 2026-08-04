# The landing page

One static page: the mark, one sentence, and a link to follow along. It has no data source,
no wallet, no navigation and no client-side state — `next build` writes plain files into
`out/`, which is why it can be put up somewhere permanent long before the contracts are
deployed and cannot break when the indexer does.

`apps/web` is the interface. This is not it, and the two are deliberately separate
deployments: the interface needs a server and a feed, and a page whose only job is to exist
should not be able to fail for either reason.

## Locally

```bash
pnpm --filter @verdant/landing dev            # http://localhost:3000
pnpm --filter @verdant/landing build          # writes out/
pnpm --filter @verdant/landing preview        # serves out/ at http://127.0.0.1:4300
pnpm --filter @verdant/landing brand          # regenerates public/brand/ from brand-source/
```

## On Vercel

Live at [verdant-landing-mauve.vercel.app](https://verdant-landing-mauve.vercel.app), as the
project `verdant-landing`. It was put there from this machine rather than from a git push,
because the repository has no remote yet:

```bash
cd apps/landing
pnpm brand && pnpm build                # only when the brand-source files changed
vercel pull --yes --environment production
vercel build --prod                     # builds here, with this workspace's pinned Next
vercel deploy --prebuilt --prod         # uploads the build; Vercel compiles nothing
```

Building locally and uploading the result is deliberate. `apps/landing` has no workspace
dependencies, so Vercel *could* install and build it alone — but its lockfile is at the
repository root, and an install that cannot see the lockfile resolves `^15.5.4` to whatever
is newest that day. `--prebuilt` deploys the bytes that were tested here.

The trade is that a deployment is a command rather than a consequence of a push. When the
repository has a remote, connecting it is the better arrangement, and then Vercel needs only
to be told where the app is:

| Setting | Value |
|---|---|
| Root Directory | `apps/landing` |
| Framework preset | Next.js (detected) |
| Build command | `pnpm build` (default) |
| Output directory | `out` (detected from `output: "export"`) |
| Install command | `pnpm install` (default, runs at the repo root) |

No secrets and no build-time network access beyond the font, which `next/font` fetches once
during the build and then serves from our own origin.

One variable matters, `NEXT_PUBLIC_SITE_URL`, and it matters more when the build happens
here than when it happens on Vercel. Link cards need an absolute image URL; a relative one
works locally and then silently produces no image once the page is shared. On Vercel's own
builders `VERCEL_PROJECT_PRODUCTION_URL` supplies it, but a `vercel build` run on a laptop
has no such variable to read, so a custom domain means setting it explicitly and building
again:

```bash
vercel env add NEXT_PUBLIC_SITE_URL production   # https://the-domain
vercel pull --yes --environment production
vercel build --prod && vercel deploy --prebuilt --prod
```

Attaching the domain alone does not do it. The value is compiled into the page's `<head>`,
so the deployment that predates the domain keeps advertising no image until it is replaced.

None of this ties the page to Vercel. The same `out/` works on any static host — a bucket,
Cloudflare Pages, GitHub Pages — which is the reason for the export rather than a server
build.

## Brand files

`public/brand/` holds the mark, the lockup, the background photograph, the link-card image
and the favicon. All of them are generated, and none of them are the file a designer hands
over: originals go in `brand-source/`, which is not committed, and

```bash
pnpm --filter @verdant/landing brand
```

turns them into the shipped versions. The reasons are specific — a 13 MB camera JPEG is not
a background, and a mark that occupies the left sixth of its canvas cannot be centred by
centring the file — and they are written out in `scripts/prepare-brand.ts` and
`public/brand/README.md`, the second of which lives in the folder because that is where
someone stands when they need it.

`src/lib/brand.ts` resolves the files by name at build time, so nothing needs wiring, and
each one is optional: with no photograph the page keeps the drifting light on a flat dark
field, and with no mark it draws one. The page is never broken by a missing file, only
plainer.

## What is in it

`src/app/page.tsx` is the whole page and `src/app/globals.css` is the whole stylesheet.
Six elements, hand-written CSS, no framework — at this size a utility framework would be a
config file to read before anyone could change a colour.

The type is Inter Tight, tracked tighter as it grows and sized with `clamp` so it is as
large as each viewport allows rather than jumping at a breakpoint. The background is four
fixed layers: the photograph, a scrim that guarantees contrast for white type over an image
nobody chose for its exposure, two soft gradients drifting across it on `transform` and
`opacity` alone so the animation stays on the compositor, and a little generated grain,
which is there because a heavily blurred photograph is a field of gradual gradients and
that is exactly what an 8-bit display bands. All of the motion stops under
`prefers-reduced-motion`.

The copy claims nothing that is not true today: the footnote says the hooks are live on
Robinhood Chain, which they have been since 2026-08-01. A link to the interface goes in
when the interface is hosted somewhere other than a laptop.
