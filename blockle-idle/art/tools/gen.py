#!/usr/bin/env python3
"""Local hand-painted-art generator for Blockle Idle (Apple Silicon / MPS).

Uses Stable Diffusion XL via Hugging Face diffusers on the M-series GPU (MPS),
reads the game's own data/*.json so prompts stay consistent and every asset is
covered, and writes PNGs straight into the res://art/... slots the game loads:

  * creatures  -> art/blocklings/<id>.png   (transparent, rembg-cut, autocropped)
  * buildings  -> art/buildings/<id>.png    (transparent)
  * heart tree -> art/buildings/heart_tree.png (transparent)
  * realms     -> art/realms/<id>_bg.png     (opaque, portrait 9:16)

Usage:
  python3 gen.py anchors     # heart_tree + verdant_bg + first 5 blocklings
  python3 gen.py buildings | blocklings | realms | all
  python3 gen.py only pip mossy ...   # specific blockling/building ids

Everything is deterministic (seed derived from the id) so re-runs reproduce.
"""
import os, sys, json, hashlib, io
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import torch
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "data")
ART = os.path.join(ROOT, "art")

STYLE = ("children's storybook illustration, hand-painted watercolor and gouache, "
         "soft diffused warm lighting, painterly textured brushwork, whimsical cozy "
         "fantasy, muted natural palette, subtle paper grain, gentle rim light, "
         "highly detailed award-winning picture-book art, no outline")
NEG = ("photograph, 3d render, cgi, plastic, low quality, blurry, jpeg artifacts, "
       "text, words, letters, watermark, signature, logo, ui, frame, border, "
       "harsh black outlines, flat vector, clipart, deformed, extra limbs, "
       "mutated, creepy, scary, grid, multiple characters")

def seed_for(s: str) -> int:
    return int(hashlib.sha256(s.encode()).hexdigest(), 16) % (2**31)

def clean_cut(img, session):
    """Cut the subject to a clean transparent sprite: alpha-matted rembg, drop
    the faint painted-vignette halo (alpha < threshold -> 0), keep only the
    largest connected blob (removes stray background bits), then autocrop."""
    import rembg
    cut = rembg.remove(img, session=session, alpha_matting=True,
                       alpha_matting_foreground_threshold=240,
                       alpha_matting_background_threshold=20,
                       alpha_matting_erode_size=8)
    arr = np.array(cut)
    a = arr[:, :, 3].astype(np.float32)
    a = np.where(a < 130, 0.0, a)
    # keep the largest connected component of the alpha mask (SciPy if present)
    try:
        from scipy import ndimage
        lab, n = ndimage.label(a > 0)
        if n > 1:
            sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
            keep = int(np.argmax(sizes)) + 1
            a = np.where(lab == keep, a, 0.0)
    except Exception:
        pass
    arr[:, :, 3] = np.clip(a, 0, 255).astype("uint8")
    out = Image.fromarray(arr)
    bbox = out.getbbox()
    return out.crop(bbox) if bbox else out

def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)

def build_jobs(which, only_ids):
    b = load_json("blocklings.json")
    bld = load_json("buildings.json")
    realms = load_json("realms.json")["realms"]
    jobs = []  # (path, prompt, kind, id)

    def blockling_prompt(e):
        return (f"A single adorable {e['shape']}-like magical fantasy creature named {e['name']}, "
                f"a gentle {e['profession']}. {e.get('desc','')} Full body, facing forward, centred, "
                f"one character only, {STYLE}, on a plain flat pale cream background, soft contact shadow.")

    def building_prompt(e):
        return (f"A single small whimsical fantasy structure: the {e['name']}. {e.get('desc','')} "
                f"Cozy storybook architecture, three-quarter view, centred, one building only, "
                f"{STYLE}, on a plain flat pale cream background, soft contact shadow.")

    for e in b["blocklings"]:
        if which in ("blocklings", "all") or (which == "only" and e["id"] in only_ids) \
           or (which == "anchors" and e["id"] in ("pip", "mossy", "cobble", "quill", "ember")):
            jobs.append((os.path.join(ART, "blocklings", e["id"] + ".png"), blockling_prompt(e), "sprite", e["id"]))

    for e in bld["buildings"]:
        is_heart = e["id"] == "heart_tree"
        want = which in ("buildings", "all") or (which == "only" and e["id"] in only_ids) \
            or (which == "anchors" and is_heart)
        if not want:
            continue
        if is_heart:
            p = ("The Heart Tree: one ancient colossal magical tree with a glowing luminous "
                 "canopy and softly lit roots, floating motes of light. One tree only, centred, "
                 f"{STYLE}, on a plain flat pale cream background, soft contact shadow.")
        else:
            p = building_prompt(e)
        jobs.append((os.path.join(ART, "buildings", e["id"] + ".png"), p, "sprite", e["id"]))

    for e in realms:
        if which in ("realms", "all") or (which == "only" and e["id"] in only_ids) \
           or (which == "anchors" and e["id"] == "verdant"):
            p = (f"A breathtaking portrait fantasy landscape: {e['name']}. {e.get('desc','')} "
                 f"Atmospheric establishing shot, layered depth, no characters, no text, "
                 f"{STYLE}, cinematic soft light.")
            jobs.append((os.path.join(ART, "realms", e["id"] + "_bg.png"), p, "bg", e["id"]))

    # Hand-painted world set-dressing so NOTHING is a flat vector shape: the
    # floating island, soft clouds, and glowing magic motes.
    world = [
        ("world/island", "A single small floating fantasy island, lush grassy green rounded top "
         "with wildflowers and a craggy earthy underside, dangling roots, one island only, "
         "three-quarter slightly-top view, centred, transparent background."),
        ("world/cloud", "A single soft fluffy stylised cloud, rounded billows, one cloud only, "
         "centred, transparent background."),
        ("fx/mote", "A single small round glowing magical light mote with a soft warm halo, "
         "one orb only, centred, plain dark background."),
    ]
    for rel, base in world:
        if which in ("world", "all") or (which == "only" and rel.split("/")[-1] in only_ids):
            jobs.append((os.path.join(ART, rel + ".png"),
                         base + " " + STYLE + ", soft painterly edges.", "sprite", rel.split("/")[-1]))

    # Combinatorial trait OVERLAY library: a few dozen hand-painted layers that
    # stack onto the species bases (see Traits.gd) to yield millions of distinct
    # Blocklings. Each is a standalone transparent prop/pattern/effect.
    traits = {
        "accessories": ["flower", "scarf", "hat", "leaf", "lantern", "glasses", "bow", "acorn", "crown", "bell", "cloak"],
        "markings": ["spots", "stripes", "dapple", "swirl", "freckles", "starmark", "patch"],
        "auras": ["sparkle", "glow", "petals", "embers", "frost"],
    }
    tprompt = {
        "accessories": "a single small {n} accessory prop by itself, one object only, no character, centred, on a plain flat pale cream background.",
        "markings": "a soft {n} pattern patch of painterly fur/skin markings, texture only, no character, centred, on a plain flat pale cream background.",
        "auras": "a soft faint glowing {n} magical aura, a gentle ring of light particles, no character, no creature, centred, on a plain flat dark background.",
    }
    for cat, names in traits.items():
        for nm in names:
            if which in ("traits", "all") or (which == "only" and nm in only_ids):
                p = tprompt[cat].format(n=nm) + " " + STYLE
                jobs.append((os.path.join(ART, "traits", cat, nm + ".png"), p, "sprite", cat + "_" + nm))
    return jobs

def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "anchors"
    only_ids = set(sys.argv[2:]) if which == "only" else set()
    jobs = build_jobs(which, only_ids)
    if not jobs:
        print("no jobs for", which); return
    print(f"[gen] {len(jobs)} assets to generate ({which})")

    # SD 1.5 (stable in fp16 on Apple-Silicon MPS; SDXL NaNs in fp16 on MPS).
    from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print("[gen] loading Stable Diffusion 1.5 on", device, "(first run downloads ~4GB)")
    pipe = StableDiffusionPipeline.from_pretrained(
        "stable-diffusion-v1-5/stable-diffusion-v1-5", torch_dtype=torch.float32, safety_checker=None)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.to(device)
    pipe.enable_attention_slicing()

    import rembg
    session = rembg.new_session("isnet-general-use")

    for path, prompt, kind, aid in jobs:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        w, h = (512, 768) if kind == "bg" else (512, 512)
        g = torch.Generator(device=device).manual_seed(seed_for(aid))
        print(f"[gen] {aid} ({kind}) {w}x{h} ...", flush=True)
        img = pipe(prompt=prompt, negative_prompt=NEG, num_inference_steps=28,
                   guidance_scale=7.5, width=w, height=h, generator=g).images[0]
        if kind == "sprite":
            cut = clean_cut(img, session)
            cut.save(path)
        else:
            img.save(path)
        print("   saved", os.path.relpath(path, ROOT), flush=True)
    print("[gen] done")

if __name__ == "__main__":
    main()
