#!/usr/bin/env python3
"""Paint the Blockle "B" app icon for Blockle Idle in the game's hand-painted
storybook style. Uses SDXL img2img from the real Blockle B mark so the letter
stays legible (diffusion can't draw clean letterforms from scratch) while gaining
watercolor/gouache texture + a warm magical glow. Writes a 1024 master, builds
the iOS/App-Store icon set, and sets it as the Godot project icon.

Run AFTER the main art batch (one SDXL pipeline at a time on 16GB)."""
import os, sys
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPO = os.path.abspath(os.path.join(ROOT, ".."))
INIT = os.path.join(REPO, "blockle-app", "assets", "icon", "blockle_icon.png")
OUT1024 = os.path.join(ROOT, "icon_1024.png")
OUT_ICON = os.path.join(ROOT, "icon.png")

PROMPT = ("a single bold capital letter B emblem, the Blockle logo, reimagined as a "
          "hand-painted watercolour and gouache storybook illustration, soft painterly "
          "brush texture, warm golden honey and leaf-green magical glow, gentle rim light, "
          "subtle paper grain, rounded friendly shape, centred app icon emblem, "
          "clean soft background, whimsical fantasy picture-book art")
NEG = ("photograph, 3d render, plastic, harsh outline, flat vector, clipart, extra letters, "
       "words, text, paragraph, watermark, signature, ugly, noisy, cluttered, frame, border")

def main():
    if not os.path.exists(INIT):
        print("init B not found:", INIT); sys.exit(1)
    from diffusers import StableDiffusionImg2ImgPipeline, DPMSolverMultistepScheduler
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print("[icon] loading SD 1.5 img2img on", device)
    pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
        "stable-diffusion-v1-5/stable-diffusion-v1-5", torch_dtype=torch.float32, safety_checker=None)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.to(device); pipe.enable_attention_slicing()

    init = Image.open(INIT).convert("RGB").resize((512, 512), Image.LANCZOS)
    g = torch.Generator(device=device).manual_seed(53000)
    # strength ~0.5 keeps the B's silhouette while repainting its surface.
    img = pipe(prompt=PROMPT, negative_prompt=NEG, image=init, strength=0.5,
               num_inference_steps=40, guidance_scale=7.5, generator=g).images[0]
    img = img.resize((1024, 1024), Image.LANCZOS)
    img.save(OUT1024)
    img.save(OUT_ICON)
    print("[icon] wrote", os.path.relpath(OUT1024, ROOT), "and icon.png")

if __name__ == "__main__":
    main()
