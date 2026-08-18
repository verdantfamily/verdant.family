# The panel on the Agen for Agents door

`art.svg` is the blue graphic filling the right-hand half of `/agents`. Drop a replacement
here and the door uses it.

## Replacing it

Keep the name and the page needs no change:

    art.svg

If your artwork is a raster — an export from Figma, a render, a photograph — put it here
under the name `art.png` (or `.jpg`, `.webp`) and change the one line that names the file
in `src/app/agents/agents.css`:

    .ag-gate-art { background-image: url("/a4a/art.svg"); }

That is the only reference to it anywhere.

## What it has to survive

The panel is cropped, not letterboxed. It is anchored to its right edge and centred
vertically, so it fills the half-screen at any window shape and loses whatever does not
fit — usually a slice off the left, and top and bottom on a wide short window. Nothing
load-bearing should live near an edge, and anything that reads as a complete object
(a logo, a face, a word) will eventually be cut.

Tall suits it better than wide. The reference is 510 × 686.

The left half of the door is text on near-black, so the artwork wants to stay dark at the
boundary where the two meet. A light or busy left edge puts a seam down the middle of the
screen.

Below 900px the panel is not rendered at all. The door becomes one column of text, because
half a screen of texture above the headline pushes the thing you are meant to read below
the fold on a phone.

## The one that ships

`art.svg` is generated, not drawn:

    node scripts/a4a-art.mjs

Rows of bars at varying lengths, seeded so the same command returns the same panel. It is
meant to read as text being written rather than as a pattern, which is why most rows stop
short of the margin. The seed and the rules are in that file.
