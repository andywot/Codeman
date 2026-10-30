#!/usr/bin/env python3
"""Rebuild the two terminal webfonts in src/web/public/fonts/ (needs fonttools + brotli).

Nothing runs this at build time: the woff2 files are committed. It exists so the
files can be reproduced, and so the next symbol that tofus can be added.

1. jetbrains-mono-variable.woff2 is JetBrains Mono 2.304's variable TTF (wght 100-800)
   from https://github.com/JetBrains/JetBrainsMono/releases, subset with:

     pyftsubset 'JetBrainsMono[wght].ttf' --flavor=woff2 --notdef-outline \
       --layout-features=calt,ccmp,frac,locl,zero \
       --unicodes=U+0000-024F,U+0259,U+02B9-02DD,U+0300-036F,U+0370-03FF,U+0400-04FF,\
U+1E00-1EFF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,\
U+2300-23FF,U+2400-2426,U+2500-25FF,U+2600-26FF,U+2700-27BF,U+27C0-27EF,U+27F0-27FF,\
U+2900-297F,U+2B00-2BFF,U+E0A0-E0A3,U+E0B0-E0B3,U+FEFF,U+FFFD \
       --output-file=jetbrains-mono-variable.woff2

   The old file was a 229-codepoint Latin subset, so box drawing, arrows and every
   symbol Claude Code draws fell through to whatever the OS had (thin, mismatched,
   or tofu on Android).

2. codeman-terminal-symbols.woff2 (this script) supplies what JetBrains Mono does not
   have at all: for each single-cell glyph in the arrows / technical / shapes /
   dingbats / misc-symbols blocks that the JetBrains subset lacks, take the glyph from
   Iosevka Term SS14 Medium (Iosevka's SS14 is its JetBrains Mono lookalike set),
   centre it in JetBrains Mono's 600-unit cell and write one static woff2.

     python3 scripts/build-terminal-symbols-font.py \
       SGr-IosevkaTermSS14-Medium.ttc \
       src/web/public/fonts/jetbrains-mono-variable.woff2 \
       src/web/public/fonts/codeman-terminal-symbols.woff2

   The Iosevka release is https://github.com/be5invis/Iosevka/releases (v34.9.1,
   asset PkgTTC-SGr-IosevkaTermSS14-*.zip). Both fonts are SIL OFL 1.1; see
   src/web/public/fonts/LICENSE-terminal-fonts.txt.
"""
import sys
import unicodedata

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont

SRC, JBM, OUT = sys.argv[1:4]
CELL = 600  # JetBrains Mono advance width (units per em 1000)
SRC_CELL = 500  # Iosevka Term advance width

BLOCKS = [
    (0x2020, 0x2023),
    (0x2190, 0x21FF),
    (0x2300, 0x23FF),
    (0x2460, 0x24FF),
    (0x25A0, 0x25FF),
    (0x2600, 0x26FF),
    (0x2700, 0x27BF),
    (0x27F0, 0x27FF),
    (0x2900, 0x29FF),
    (0x2B00, 0x2BFF),
]

jbm_cmap = TTFont(JBM).getBestCmap()
src = TTCollection(SRC).fonts[0]
cmap = src.getBestCmap()
hmtx = src["hmtx"]

want = set()
for lo, hi in BLOCKS:
    for cp in range(lo, hi + 1):
        if cp in jbm_cmap or cp not in cmap:
            continue
        if unicodedata.category(chr(cp)) in ("Mn", "Me", "Cf", "Cc"):
            continue
        if hmtx[cmap[cp]][0] != SRC_CELL:  # single-cell glyphs only
            continue
        want.add(cp)
want.add(0x2500)  # outline source for the U+23AF alias below
print("selected", len(want), "codepoints")

opts = subset.Options()
opts.layout_features = []
opts.hinting = False
opts.notdef_outline = True
opts.name_IDs = [1, 2, 3, 4, 5, 6]
opts.drop_tables += ["GSUB", "GPOS", "GDEF", "kern", "STAT", "gasp"]
subsetter = subset.Subsetter(opts)
subsetter.populate(unicodes=sorted(want))
subsetter.subset(src)

glyph_set = src.getGlyphSet()
glyf = src["glyf"]
cmap = src.getBestCmap()
line_glyph = cmap[0x2500]

jbm = TTFont(JBM)
jbm_glyph_set = jbm.getGlyphSet()

# Iosevka's geometric shapes are drawn about 2/3 the size of JetBrains Mono's own
# (a 422-unit box against JetBrains Mono's 620), so a spinner or bullet beside
# JetBrains Mono text looks like a speck. Small single-shape glyphs are scaled up
# to match; the checks/crosses and the tall U+23BF bracket are already full size.
SRC_CENTER = (SRC_CELL / 2, 340)  # centre of Iosevka's shapes (x, y)
DST_CENTER = (CELL / 2, 360)  # centre of JetBrains Mono's shapes
MAX_SCALE = 1.3
SMALL = 450  # bbox side (units) at or below which a glyph counts as a small shape

# The media-control glyphs Claude Code uses are better taken from JetBrains Mono's
# own solid shapes (same corners, same weight) than from Iosevka's slim ones:
# {codepoint: (JetBrains Mono codepoint, scale about the shape centre)}
FROM_JBM = {
    0x23F4: (0x25C0, 0.76),  # left-pointing triangle
    0x23F5: (0x25B6, 0.76),  # right-pointing triangle (the "⏵⏵ auto mode on" footer)
    0x23F6: (0x25B2, 0.76),
    0x23F7: (0x25BC, 0.76),
    0x23F9: (0x25A0, 0.78),  # stop square
    0x23FA: (0x25CF, 0.80),  # record circle (Claude Code's tool bullet)
}
jbm_cmap = jbm.getBestCmap()
from_jbm_names = {
    cmap[cp]: (jbm_cmap[jcp], k) for cp, (jcp, k) in FROM_JBM.items() if cp in cmap and jcp in jbm_cmap
}

new_glyphs = {}
for name in src.getGlyphOrder():
    if name == ".notdef":
        continue
    pen = TTGlyphPen(glyph_set)
    if name in from_jbm_names:
        jname, k = from_jbm_names[name]
        cx, cy = DST_CENTER
        jbm_glyph_set[jname].draw(TransformPen(pen, (k, 0, 0, k, cx - k * cx, cy - k * cy)))
    else:
        bp = BoundsPen(glyph_set)
        glyph_set[name].draw(bp)
        b = bp.bounds
        side = max(b[2] - b[0], b[3] - b[1]) if b else 0
        if name == line_glyph:
            # A horizontal rule is stretched to the whole cell so neighbours join.
            matrix = (CELL / SRC_CELL, 0, 0, 1, 0, 0)
        elif b and side <= SMALL:
            k = min(MAX_SCALE, 600 / side)
            matrix = (k, 0, 0, k, DST_CENTER[0] - k * SRC_CENTER[0], DST_CENTER[1] - k * SRC_CENTER[1])
        else:
            matrix = (1, 0, 0, 1, (CELL - SRC_CELL) / 2, 0)
        glyph_set[name].draw(TransformPen(pen, matrix))  # also flattens composites
    new_glyphs[name] = pen.glyph()

# Assigned only now: a composite drawn above must not see an already-moved component.
for name, glyph in new_glyphs.items():
    glyf[name] = glyph
    glyph.recalcBounds(glyf)
    src["hmtx"][name] = (CELL, getattr(glyph, "xMin", 0) or 0)

# U+23AF HORIZONTAL LINE EXTENSION (Claude Code draws it) shares U+2500's outline.
for table in src["cmap"].tables:
    if table.isUnicode():
        table.cmap[0x23AF] = line_glyph

src["post"].formatType = 3.0
for rec in src["name"].names:
    if rec.nameID in (1, 4, 16):
        rec.string = "Codeman Terminal Symbols"
    elif rec.nameID == 6:
        rec.string = "CodemanTerminalSymbols"
    elif rec.nameID in (2, 17):
        rec.string = "Regular"
    elif rec.nameID == 3:
        rec.string = "CodemanTerminalSymbols-Regular"
src["OS/2"].usWeightClass = 400
src.flavor = "woff2"
src.save(OUT)
print("saved", OUT)
