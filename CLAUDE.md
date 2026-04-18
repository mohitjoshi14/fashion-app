# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env  # then fill in your keys
```

Set **exactly one** of `ANTHROPIC_AUTH_TOKEN` (OAuth) or `ANTHROPIC_API_KEY` — not both. Set `OPENAI_API_KEY` or `OPENROUTER_API_KEY` depending on which provider you use.

## Running notebooks

```bash
jupyter notebook                          # open any notebook interactively
jupyter nbconvert --to notebook --execute notebooks/extract_metadata.ipynb
```

The notebooks are self-contained; there is no separate test or build step.

## Architecture

The project is a multi-provider AI fashion pipeline implemented entirely in Jupyter notebooks under `notebooks/`.

**Two main notebooks:**

1. **`extract_metadata.ipynb`** — Full pipeline:
   - **Section 1 (Helpers):** Shared utilities — provider clients (OpenAI, Anthropic, OpenRouter), image encoding, JSON parsing.
   - **Section 2 (Vision):** `extract_clothing_metadata()` — sends a clothing image to a vision model; returns structured JSON per `EXTRACTION_SYSTEM` schema (type, colors, fit, style, seasonality, pairing hints).
   - **Section 3 (Batch):** Runs extraction over all images in `notebooks/images/` → writes per-item JSON to `notebooks/metadata/`.
   - **Section 4 (Outfit text):** `suggest_outfit_combinations()` — text LLM call; reads the wardrobe JSON array and a user query; returns ranked outfit combos with `top`/`bottom`/`score`/`reasons`.
   - **Section 5 (Preview gen):** `generate_outfit_preview_images()` — calls an image generation model (OpenAI `images.edit` or OpenRouter Gemini) with reference garment photos to render photorealistic outfit previews; saves PNGs + sidecar `_meta.json` to `outputs/outfit_previews/`.

2. **`grid_outfit_gemini_experiment.ipynb`** — Alternative single-call approach:
   - Renders all wardrobe images into one matplotlib grid PNG (filenames as subplot titles).
   - Sends that single grid image + a text query to a vision model (`recommend_outfits_from_grid()`).
   - The model reads filenames from the subplot titles and returns outfit combos — no separate metadata extraction step required.

**Provider abstraction:** Both notebooks accept `provider` ∈ `{"openai", "anthropic", "openrouter"}` as a config variable. OpenRouter is used as an OpenAI-compatible client pointed at `https://openrouter.ai/api/v1`.

**FashionCLIP model** is saved to `models/fashion-clip/` on first run via `save_pretrained` — subsequent loads are fully offline. Add `models/` to `.gitignore` if not already present (~600 MB).

**Directory layout (relative to project root):**
- `notebooks/images/` — input wardrobe photos
- `notebooks/metadata/` — per-item extracted JSON (output of batch step)
- `notebooks/outputs/combinations.json` — ranked outfit suggestions
- `notebooks/outputs/outfit_previews/` — rendered outfit preview PNGs
- `notebooks/person/` — optional reference photo for identity-preserving generation

**`top` field in outfit combos** can be a single filename string or a JSON array ordered outer → inner (e.g. `["jacket.jpg", "tee.jpg"]`) to support layered looks.
