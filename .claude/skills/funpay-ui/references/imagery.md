# Imagery — what the photos are, and how to generate them

Applies to the borrower side only. The Ops dashboard uses no photography.

Photography in this direction is **colour, not subject**. A leaf is on screen because it supplies a green-to-cream gradient with organic grain, not because the app is about plants. Every image must pass one test: could you drop a 44px white title on it and read it without a scrim? If not, it's wrong.

## The four image types

### 1. Macro botanical (primary — Home screen, hero background)
A single organic form filling the frame: a calla lily spathe, a backlit leaf, a petal's veins, a fern frond, a grass blade. Backlit so the form glows from within. One subject, no bouquet, no background context.

- **Grade:** olive and moss greens through chartreuse to cream highlights. Shadows sit at `#3e4c1a`, midtones `#a9b46c`, highlights `#e6ead0`. No saturated green — think a leaf through tracing paper.
- **Focus:** shallow, with the sharpest zone about a third of the way up. Edges melt.
- **Composition:** the form should rise from the bottom and lean to one side, leaving a clean, lighter area in the upper third for the title and a darker mass in the lower third for the write-line and chips. Vertical 9:16.
- **Texture:** fine vein lines running diagonally at roughly 110–115°. This is the detail the CSS stand-in (soft-light stripes) is imitating.

### 2. Motion-blurred portrait (credit-line board, statement board)
A person, but never legible. Face turned, eyes closed, or covered by a flower held to the face; long-exposure smear or double exposure. The figure is a warm mass with a pale flower as the only crisp element.

- **Grade:** olive-clay, `#354a2c` to `#c9d3b5`, with a pale cream bloom `#e3e8c8`. Keep it green-leaning; the warm-brown version belongs to a different product. Slight film grain. Desaturate skin so it's closer to clay than flesh.
- **Rules:** no identifiable face in focus, ever. No direct eye contact. If a generator returns a sharp face, regenerate or blur to at least 12px radius.
- **Composition:** figure centred, flower upper-centre, so a dark-glass card can sit across the middle third.

### 3. Figure in soft green (swatch #5, inline avatar in headlines)
A person from the shoulders up in a pale green knit or ribbed top, against a green-grey field, with heavy softening so it reads as a colour blob. Used at 40–60px as an inline avatar inside a headline and as one of the nine palette swatches.

- **Grade:** `#d9e6b8` highlights to `#3e4a2c` shadows.
- **Rules:** small, so detail is wasted; prioritise silhouette and colour.

### 4. Dark abstract (swatch #8, void textures)
Near-black with a faint cool gradient — a shadowed shoulder, a dark curtain, a blurred figure against black. Used for the darkest swatch and for texture behind dark boards.

- **Grade:** `#111` to `#2b2b2b`, cool bias.

## Palette mapping

Three of the nine swatches are photographic. When generating, aim each image at the swatch it must average to:

| Swatch | Image type | Target average |
|---|---|---|
| Portrait | Motion-blurred portrait | `#6a7a55` — green-clay, not warm brown, to sit with the FunPay palette |
| Figure | Figure in soft green | `#6a7a55` |
| Dark | Dark abstract | `#0b1a12` — cool green-black, matching `--forest-deep` |

All other swatches are flat values from `tokens.css`; no images.

## Universal grade

Apply to every generated image before use:
- Saturation −20 to −35%
- Highlights lifted to cream (`#f4f3ea`), never pure white
- Blacks lifted to `#1f1f1f` or the leaf-dark, never `#000`
- Faint grain, 2–4% at 1x
- Optional: a lilac (`#ecd8f5`) or peach (`#f2b48f`) tint at 6–10% in the highlights on install/about boards, to marry the photo to the gradient behind it

## Composition per placement

| Placement | Aspect | Clear zone for type | Notes |
|---|---|---|---|
| Home screen background | 9:17 | Upper third light, lower third dark | Credit numeral upper-middle, loan chip + companion + chips bottom |
| Credit-line board | 4:3 or 1:1 | Middle third | Light glass pass and dark sheet cross centre |
| About/statement board | 1:1 | Not needed | Used only as the inline avatar crop |
| Swatch | 1:1 | Not needed | Crop to the most uniform 200×200 region |

## Generation prompts

Written for Midjourney / Firefly / Imagen / DALL·E-style tools. Keep the aspect flag matching the placement. Always add the negative list.

**Macro botanical (note screen)**
```
macro photograph of a single backlit calla lily spathe, translucent, veins visible,
olive and chartreuse green fading to cream at the top, extremely shallow depth of field,
soft diffused light, muted desaturated film look, fine grain, no background, vertical
--ar 9:16
```
Variants: swap "calla lily spathe" for "curled leaf edge", "fern frond unrolling", "tulip petal from inside", "grass blade with dew". Keep every other word.

**Motion-blurred portrait (install board)**
```
long exposure portrait, person with a pale flower held over their face, motion blur,
face not visible, olive green and clay tones, muted, soft cream flower petals as the
only sharp detail, grainy analog film, dark green shadows, editorial, no eye contact
--ar 4:3
```

**Figure in soft green (avatar / swatch)**
```
soft-focus portrait from the shoulders up, person in a pale sage green ribbed knit top,
green-grey background, heavily diffused, face turned away and out of focus, muted pastel,
colour study, minimal
--ar 1:1
```

**Dark abstract (swatch)**
```
near-black photograph, shadowed shoulder of a figure against black, faint cool grey
gradient, almost no detail, grainy, moody, minimal
--ar 1:1
```

**Negative list (append to every prompt)**
```
--no text, watermark, logo, saturated colours, neon, bright white, sharp face,
eye contact, bouquet, multiple subjects, stock photo lighting, HDR
```

## When generation isn't available

Paint the palette instead of leaving flat colour. The CSS recipe is in `components.md` under "Screen shell" (`.screen.leaf`); the WebGL canvas-texture version is in `glass-webgl.md` under pitfall 2. Both produce the right gradient and grain; neither produces the vein detail, so say so to the user and recommend a real macro shot for the final.

## Never

- Faces in focus, or anyone recognisable
- Stock photography with catalogue lighting
- Saturated flowers (red roses, yellow sunflowers) — the palette is green, cream, clay, lilac
- Images with baked-in text, UI, or devices
- Pure white or pure black anywhere in the frame
- More than one subject
