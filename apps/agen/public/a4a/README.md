# The panel on the Agen for Agents door

`lines.png` is the blue graphic filling the right-hand half of `/agents`. Drop a replacement
here and the door uses it.

## Replacing it

Keep the name and the page needs no change:

    lines.png

Under any other name — including a different extension — change the one line that names the
file in `src/app/agents/agents.css`:

    .ag-door-art { background-image: url("/a4a/lines.png"); }

That is the only reference to it anywhere.

## What it has to survive

The panel is cropped, not letterboxed. It is anchored to its right edge and centred
vertically, so it fills the half-screen at any window shape and loses whatever does not
fit — usually a slice off the left, and top and bottom on a wide short window. Nothing
load-bearing should live near an edge, and anything that reads as a complete object
(a logo, a face, a word) will eventually be cut.

Tall suits it better than wide. The one shipping is 1440 × 1788.

The left half of the door is text on near-black, so the artwork wants to stay dark at the
boundary where the two meet. A light or busy left edge puts a seam down the middle of the
screen.

Below 900px the panel is not rendered at all. The door becomes one column of text, because
half a screen of texture above the headline pushes the thing you are meant to read below
the fold on a phone.

## Weight

This is a background on a page people wait at, so it should not be a megabyte. Flat artwork
of a few colours belongs in a palette PNG, which costs a fraction of the same image in RGB:

    python3 - <<'EOF'
    from PIL import Image
    im = Image.open('lines.png').convert('RGB')
    w = 1440
    im.resize((w, round(im.height * w / im.width)), Image.LANCZOS) \
      .quantize(colors=8, dither=Image.NONE).save('lines.png', optimize=True)
    EOF

The file that ships went from 2.4 MB to 124 KB this way with no visible difference at the
size it is displayed.
