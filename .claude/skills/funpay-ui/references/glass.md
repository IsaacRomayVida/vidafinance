# Glass — Tier 2 real refraction with three.js

Used only for the borrower hero (balance / credit card). The Ops side has no WebGL; its glass is all CSS (`components.md`). Everything below is the recipe from `assets/reference.html`, `<script type="module">` at the bottom.

Use this for exactly one hero element per view. It costs a full extra scene render per frame.

## What it produces that CSS cannot

- **Refraction** — geometry behind the card is bent and displaced at the rim, not blurred.
- **Chromatic aberration** — the `dispersion` property splits wavelengths so edges fringe blue/orange.
- **Thickness** — frost concentrates where light travels through more material (the bevel).
- **Absorption** — `attenuationColor` tints light as it crosses the volume.

## Setup

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/" } }
</script>
```
Need r163+ for `dispersion`. Use `RoomEnvironment` + `PMREMGenerator` for `scene.environment`; a transmission material with no env map is a dead grey slab.

```js
renderer.toneMapping = THREE.NeutralToneMapping;   // ACES crushes pastels to grey
```

## The material

```js
new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  transmission: 1,
  transparent: true,          // REQUIRED — see pitfall 3
  thickness: 0.7,             // 0.6–1.2; higher = denser frost in the centre
  roughness: 0.2,             // the frost; 0.15–0.25 for this direction
  ior: 1.46,
  dispersion: 2.4,            // 1.5–3 gives the rim fringe without rainbow soup
  clearcoat: 1, clearcoatRoughness: 0.08,
  attenuationColor: new THREE.Color(0xe4f2e6),   // pale green — FunPay tint
  attenuationDistance: 3.5,
  envMapIntensity: 1.2,
  side: THREE.DoubleSide
});
```

## The geometry

Not a plane. An extruded rounded rectangle with a bevel — the bevel is where the refraction lives.

```js
function roundedSlab(w, h, d, r){
  const s = new THREE.Shape(), x = -w/2, y = -h/2;
  s.moveTo(x+r, y); s.lineTo(x+w-r, y); s.quadraticCurveTo(x+w, y, x+w, y+r);
  s.lineTo(x+w, y+h-r); s.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  s.lineTo(x+r, y+h); s.quadraticCurveTo(x, y+h, x, y+h-r);
  s.lineTo(x, y+r); s.quadraticCurveTo(x, y, x+r, y);
  const bev = Math.min(d*0.3, 0.07);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(d-bev*2, .01), bevelEnabled:true,
    bevelThickness:bev, bevelSize:bev, bevelSegments:5, curveSegments:26 });
  g.center(); return g;
}
```
Card ≈ 3.1 × 2.2 × 0.3 units, radius 0.36, camera at z 6.6 with fov 36.

## Text on the glass

Text goes in the **DOM**, not on a canvas texture. A texture would be refracted into itself and go soft. Overlay a div sized from the camera frustum so it lands pixel-exact on the front face:

```js
const dist = CAM_Z - CARD_D/2;
const visibleH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov)/2);
const px = container.clientHeight / visibleH;
face.style.width  = CARD_W * px + 'px';
face.style.height = CARD_H * px + 'px';
face.style.fontSize = CARD_H * px + 'px';   // then size children in em
face.style.transform = 'translate(-50%,-50%) rotate(' + (-TILT*180/Math.PI) + 'deg)';
```
Keep the card's rotation to the Z axis only so a CSS `rotate()` matches it exactly.

## Pitfalls — each of these has cost a real hour

1. **Transparent backdrop objects vanish.** Three's transmission pass renders only *opaque* geometry into the buffer the glass samples. Anything with `transparent:true` behind the glass is invisible through it. Fake distance by lerping colour toward the background, never by lowering opacity.
2. **Empty buffer reads as opaque white.** If nothing opaque sits behind the card, the glass falls back to its diffuse colour and looks like a frosted slab. Always place an opaque wall (a `PlaneGeometry` with a `CanvasTexture` of the painted background) a few units behind. Paint the leaf palette (`--leaf-light` → `--leaf-mid` → `--leaf-dark`) onto a 1024² canvas with radial gradients plus soft-light stripes; set `texture.colorSpace = THREE.SRGBColorSpace`.
3. **`transparent:true` on the glass itself.** Without it three ignores the transmission alpha and the card never lets the background through.
4. **Rotation sign flips between three and CSS.** Three rotates counter-clockwise for positive Z (y up); CSS `rotate()` is clockwise (y down). Negate the angle for the DOM overlay or the text sits crooked on the card.

Secondary: don't use ACES tone mapping with pastels; don't put a transmission material on more than one mesh per view; `dispersion` above ~4 turns into a rainbow.

## Fitting narrow viewports

```js
const visibleW = visibleH * camera.aspect;
const fit = Math.min(1, (visibleW * 0.86) / CARD_W);
glass.scale.setScalar(fit);
face.style.transform += ' scale(' + fit + ')';
```

## Motion

Pointer parallax moves the backdrop group, not the glass or camera: `target = pointer * 0.9`, lerp `0.06`. Backdrop slabs drift on `sin(t*0.22 + phase)` loops with ±0.35 amplitude. Stop drift under `prefers-reduced-motion`.

## When not to use this

Lists, repeated cards, anything below the fold on mobile, anything the user won't look at for more than a second. Fall back to Tier 1 CSS frosted glass, which costs nothing.
