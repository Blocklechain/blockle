# Blockle Idle — Draw Things Prompt Pack (Apple Silicon / M2)

Ready-to-run prompts for generating the hand-painted storybook assets locally in
**Draw Things** on an M2 Mac. Every prompt obeys `ART_BIBLE.md`; the hex values come
straight from `data/`. Each generated image maps to an exact in-game file path — see
`NAMING.md`.

**Generate these FIRST to lock the visual identity (in this order):**
**Heart Tree -> starting island -> Pip -> Mossy -> Cobble -> Quill -> Ember.**
Approve those seven before producing anything else; they define the whole family.

---

## How to run (M2 / Draw Things)

- Model: a watercolour/storybook-leaning SDXL checkpoint (or SD 1.5 watercolour model).
  Keep the **same model + seed family** across a set so the style stays consistent.
- Sampler: DPM++ 2M Karras (or Euler a). Steps 28-36. CFG 6-8.
- **Characters & buildings:** square, **1024x1024**, transparent background
  (use a transparent/alpha-capable workflow or generate on flat `#FBF6E9` and key it
  out). Subject centred, generous margin.
- **Realm backgrounds:** **portrait 896x1536** (9:16), full-bleed, no transparency.
- Paste the **STYLE tokens** at the front of every prompt and the **NEGATIVE prompt**
  into the negative field for every generation.
- Generate 4-6 variants per asset, pick the one that best matches the silhouette rules
  in the Art Bible, then upscale.

---

## Shared STYLE tokens (prepend to every prompt)

```
hand-painted children's storybook illustration, watercolour and gouache, soft washes,
visible brushwork, painted irregular edges, cold-press paper grain texture, cozy and
whimsical, warm soft upper-left key light, gentle magical rim light, soft contact
shadow, rounded organic shapes, muted but warm palette, picture-book look, no outlines
drawn in ink, painterly, high detail, centered composition
```

## Shared NEGATIVE prompt (paste into every negative field)

```
text, words, letters, numbers, watermark, signature, logo, caption, UI, interface,
emoji, cryptocurrency, coins, blockchain, money, photograph, photorealistic, 3d render,
cgi, plastic, glossy, chrome, hard vector outline, flat vector, cel shaded, anime,
pixel art, harsh shadows, pure black, neon, oversaturated, cluttered, busy background,
scary, grim, sharp teeth, realistic human face, deformed, extra limbs, blurry, jpeg
artifacts, low quality, frame, border
```

For every **character and building**, also append to the positive prompt:
`centered single subject, transparent background, isolated on plain paper, lots of
empty margin`.

---

## Priority 1 — Heart Tree (hero)

```
[STYLE] a great ancient whimsical Heart Tree on a small floating island, the heart of
a magical kingdom, gnarled rounded trunk with a softly glowing warm green core light
(#7FE3B0), lush rounded canopy in forest green (#2E7D4F) with mint-green highlights
(#7FE3B0), warm brown bark (#C9955B), roots that wrap down and cradle the island, tiny
warm golden light in the hollows, tallest and most important structure, storybook hero
subject, gentle magical motes drifting, Verdant realm palette, centered single subject,
transparent background, lots of empty margin
```

## Priority 2 — Starting island (Verdant background)

```
[STYLE] portrait scene, a small lush floating island adrift in a soft dawn sky, viewed
from slightly above at a gentle 3/4 angle so we see the grassy top and the island's
rooty underside, calm hopeful morning, sky graduating from soft teal at the top
(#8FD3C4) through pale mint (#D9F2E6) to warm paper-white near the island (#FBF6E9),
rich green grass and a few rounded trees (#2E7D4F), gentle streams, distant smaller
floating islands fading into the sky, soft clouds, layered depth, atmospheric
perspective, foreground leaves framing the bottom edge, no buildings, serene storybook
world, full bleed portrait background
```

---

## Priority 3 — The first five Blocklings

Shared Blockling tokens (append to each): `tiny cute chibi creature, big round head
about half its height, large warm round eyes with a small highlight, soft rounded blob
body, stubby little limbs, gentle friendly face with a tiny smile, readable chunky
silhouette, single character, transparent background, lots of empty margin`.

### Pip (sprout, Common)
```
[STYLE] [BLOCKLING TOKENS] Pip, a little sprout-creature, soft leaf-green body
(#86C06C) with a darker green belly and markings (#3F6B3A), one single curling green
sprout-leaf growing from the top of its head as its signature feature, cheerful and
humming, faint cool-grey common-rarity glow (#B9C2CC) behind it
```

### Mossy (mossling, Common)
```
[STYLE] [BLOCKLING TOKENS] Mossy, a gentle moss-creature, mossy green body (#4F8A5B)
with bright mint accents (#7FE3B0), a tiny garden of moss and little plants growing on
a soft hump on its back as its signature feature, calm and content, faint cool-grey
common-rarity glow (#B9C2CC) behind it
```

### Cobble (pebble, Common)
```
[STYLE] [BLOCKLING TOKENS] Cobble, a round little rock-creature, smooth perfectly
round grey stone body (#9AA3AD) with darker grey shading (#6E7680), its signature is
being an almost perfectly round smooth pebble with tiny stubby feet, surprisingly
quick and friendly, faint cool-grey common-rarity glow (#B9C2CC) behind it
```

### Quill (owlet, Common)
```
[STYLE] [BLOCKLING TOKENS] Quill, a tiny owlet-scholar creature, warm tan-brown body
(#C9955B) with a cream feathered belly (#E8C39E), soft owl ear-tufts and a little book
held to its chest as its signature features, curious and wide-eyed, faint cool-grey
common-rarity glow (#B9C2CC) behind it
```

### Ember (cat, Uncommon)
```
[STYLE] [BLOCKLING TOKENS] Ember, a warm little artisan cat-creature, glowing ember-
orange body (#E08A4A) with soft golden accents on ears, paws and curled tail (#FFC978),
signature pointed cat ears and a curled tail, warm-hearted and cozy, a soft warm green
uncommon-rarity glow (#7FE3B0) behind it, a faint warm firelight inside it
```

---

## Buildings (one per building)

All buildings: rounded, organic, whimsical, hand-raised look, small warm glowing round
windows where inhabited, `centered single subject, transparent background, lots of
empty margin`. Palettes = `art.palette` (main / accent / detail) from
`data/buildings.json`.

### Lumber Grove
```
[STYLE] a whimsical Lumber Grove building, a cluster of gentle rounded giant trees
tended into a cozy timber workshop, deep forest green foliage (#3F6B3A) with light
green highlights (#86C06C), warm cut-timber brown structure (#C9955B), stacked logs,
soft and organic, storybook, centered single subject, transparent background
```

### Stone Quarry
```
[STYLE] a whimsical Stone Quarry building, a rounded terraced dig into pale stone with
cozy wooden supports, soft grey stone (#9AA3AD) with darker grey shadows (#6E7680) and
warm timber beams (#C9955B), chunky rounded boulders, patient and solid, storybook,
centered single subject, transparent background
```

### Crystal Mine
```
[STYLE] a whimsical Crystal Mine building, a rounded mine entrance sprouting clusters
of softly glowing blue crystals, sky-blue crystal (#8FB8FF) with deeper blue cores
(#5C7CC4) and grey stone surround (#9AA3AD), gentle humming magic glow, storybook,
centered single subject, transparent background
```

### Essence Garden
```
[STYLE] a whimsical Essence Garden building, terraced flower beds catching magic,
glowing mint-green foliage (#7FE3B0) with deep green (#2E7D4F) and little violet
blossoms (#C79BFF), soft magical motes rising, lush and alive, storybook, centered
single subject, transparent background
```

### Blockling Homes
```
[STYLE] whimsical Blockling Homes, tiny round cozy cottages with domed roofs and small
round windows glowing warm gold from inside, warm timber walls (#C9955B) with cream
trim (#E8C39E) and green roofs (#3F6B3A), inviting and homey, storybook, centered
single subject, transparent background
```

### Research Library
```
[STYLE] a whimsical Research Library building, a rounded cozy tower of books with a
domed roof and warm-lit round windows, soft blue walls (#5C7CC4) with violet accents
(#C79BFF) and timber trim (#C9955B), scholarly and calm, storybook, centered single
subject, transparent background
```

### Explorer's Lodge
```
[STYLE] a whimsical Explorer's Lodge building, a cozy rounded cabin with a warm hearth
glowing inside, timber-brown walls (#C9955B) with green roof (#3F6B3A) and golden
lantern light (#FFC978), maps and a little flag, adventurous and warm, storybook,
centered single subject, transparent background
```

### Ancient Observatory
```
[STYLE] a whimsical Ancient Observatory building, a rounded domed tower with a great
lens aimed at the sky gathering stardust, soft violet dome (#C79BFF) with blue body
(#5C7CC4) and golden brass fittings (#FFC978), gentle starlight motes, mystical and
calm, storybook, centered single subject, transparent background
```

### Relic Temple
```
[STYLE] a whimsical ancient Relic Temple building, a rounded weathered shrine older
than the island, warm golden stone (#FFC978) with violet magic veins (#C79BFF) and
grey stone (#9AA3AD), softly glowing relic fragments, sacred and quiet, storybook,
centered single subject, transparent background
```

---

## Realm backgrounds (one wide portrait per realm)

All realms: portrait 896x1536, floating-island world seen from slightly above at a 3/4
angle, layered parallax depth, atmospheric perspective, full-bleed, no transparency.
Sky graduates far -> mid -> near from the realm's `sky[]`; the accent keys the glow.

### Verdant Beginning
```
[STYLE] portrait floating-island realm, lush green dawn, sky from soft teal (#8FD3C4)
through pale mint (#D9F2E6) to warm paper-white (#FBF6E9), forest-green island (#2E7D4F
accent), rounded trees, streams, distant islands fading into sky, hopeful morning, full
bleed portrait background
```

### Crystal Hollow
```
[STYLE] portrait floating-island realm inside a deep crystal cavern, dark sky from deep
indigo (#2A2350) through violet-blue (#4C3A80) to glowing sky-blue (#8FB8FF accent),
living crystals glowing blue in the dark, drifting glowing motes, hushed underground
wonder, full bleed portrait background
```

### The Skylands
```
[STYLE] portrait floating-island realm high in a bright windy sky, sky from soft blue
(#AED4FF) through pale blue-white (#E7F2FF) to warm cream (#FFF4D6), islands strung
together by bridges of cloud (#5C7CC4 accent), high airy wind, soft clouds, full bleed
portrait background
```

### The Forgotten Wilds
```
[STYLE] portrait floating-island realm, an enchanted overgrown dark forest, sky from
near-black green (#16281F) through deep green (#2E5E43) to glowing bioluminescent green
(#9CF0B0 accent), glowing mushrooms and rare blooms, half-remembered forest spirits as
soft lights, mysterious and alive, full bleed portrait background
```

### Frostfall
```
[STYLE] portrait floating-island realm, frozen and hushed, sky from soft blue-grey
(#B7D6E8) through pale icy blue (#E4F1F7) to white (#FFFFFF), snow-heavy rounded pines,
frozen lakes, a distant palace of ancient ice (#9ED3EA accent), pale and cozy not cold,
soft snow in the air, full bleed portrait background
```

### The Astral Realm
```
[STYLE] portrait floating-island realm adrift in the cosmic ocean, night sky from deep
black-violet (#140C33) through indigo (#3B2A6B) to glowing celestial violet (#C79BFF
accent), celestial islands with observatories of star and glass, soft stars and
nebulae, serene cosmic wonder, full bleed portrait background
```

### The First Kingdom
```
[STYLE] portrait floating-island realm, the ancient origin kingdom at golden dusk, sky
from deep warm brown (#2B1B08) through amber (#7A4E1E) to glowing warm gold (#FFC978
accent), grand rounded ruins remembering a forgotten civilization, warm golden light,
reverent and ancient, full bleed portrait background
```
