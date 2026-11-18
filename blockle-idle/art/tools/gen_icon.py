#!/usr/bin/env python3
"""Paint the Blockle "B" app icon for Blockle Idle in the game's hand-painted
style. img2img anchors too hard to the hard-edged logo, so instead we take the
real B as a SHAPE MASK and fill it with a generated watercolour/gouache texture
over a soft painted cream ground. This guarantees a legible, on-brand Blockle B
that is genuinely hand-painted. Writes a 1024 master + the Godot project icon."""
import os, sys
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPO = os.path.abspath(os.path.join(ROOT, ".."))
INIT = os.path.join(REPO, "blockle-app", "assets", "icon", "blockle_icon.png")
OUT1024 = os.path.join(ROOT, "icon_1024.png")
OUT_ICON = os.path.join(ROOT, "icon.png")

TEX_PROMPT = ("a lush leaf-green and honey-gold watercolour and gouache paint texture, "
              "thick painterly brush strokes, hand-painted storybook, soft paper grain")
NEG = "photo, 3d render, glossy, text, letters, watermark, flat vector, hard edges"

def main():
    if not os.path.exists(INIT):
        print("init B not found:", INIT); sys.exit(1)
    from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print("[icon] loading SD 1.5 (texture) on", device)
    pipe = StableDiffusionPipeline.from_pretrained(
        "stable-diffusion-v1-5/stable-diffusion-v1-5", torch_dtype=torch.float32, safety_checker=None)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.to(device); pipe.enable_attention_slicing()
    g = torch.Generator(device=device).manual_seed(53000)
    tex = pipe(prompt=TEX_PROMPT, negative_prompt=NEG, num_inference_steps=30,
               guidance_scale=7.5, width=512, height=512, generator=g).images[0]
    tex = tex.resize((1024, 1024), Image.LANCZOS)

    # B shape mask from the real logo (the bright green glyph on black).
    b = Image.open(INIT).convert("L").resize((1024, 1024), Image.LANCZOS)
    m = np.array(b)
    mask = Image.fromarray(np.where(m > 55, 255, 0).astype("uint8"))
    mask = mask.filter(ImageFilter.GaussianBlur(3))  # soft painted edge

    # Soft cream painted ground with a gentle vignette.
    bg = Image.new("RGB", (1024, 1024), (244, 236, 214))
    vig = Image.new("L", (1024, 1024), 0)
    d = ImageDraw.Draw(vig)
    d.ellipse([-120, -120, 1144, 1144], fill=40)
    bg = Image.composite(Image.new("RGB", (1024, 1024), (228, 220, 196)), bg, vig)

    # A faint darker painted edge under the B for depth, then the textured B.
    edge = mask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(4))
    bg = Image.composite(Image.new("RGB", (1024, 1024), (120, 120, 90)), bg, edge.point(lambda v: int(v * 0.35)))
    out = Image.composite(tex, bg, mask).convert("RGB")
    out.save(OUT1024)
    out.save(OUT_ICON)
    print("[icon] wrote icon_1024.png and icon.png (masked watercolour B)")

if __name__ == "__main__":
    main()
