#!/usr/bin/env python3
"""Rebuild extract_metadata.ipynb: helpers first, then prompt+function groups per section."""
import json
import re
from pathlib import Path

# Writes the pipeline notebook; default is the v2 file (keeps `extract_metadata.ipynb` untouched).
NB = Path(__file__).resolve().parent / "extract_metadata_v2.ipynb"


def to_lines(text: str) -> list[str]:
    if not text.endswith("\n"):
        text += "\n"
    return text.splitlines(True)


def main() -> None:
    nb = json.loads(NB.read_text(encoding="utf-8"))
    old = "".join(nb["cells"][1]["source"])

    # Byte indices from analysis
    i_extra = old.index("EXTRACTION_SYSTEM")
    i_img = old.index("def _image_bytes_and_mime")
    i_ext = old.index("def extract_clothing_metadata")
    i_outfit_sys = old.index("OUTFIT_SYSTEM =")
    i_oai = old.index("def _openai_like_client")
    i_sug = old.index("def suggest_outfit_combinations")
    i_load = old.index("def load_wardrobe_from_metadata_dir")
    i_dec = old.index("def _decode_data_url_to_png_bytes")
    i_or = old.index("def _openrouter_chat_image_generation")
    i_oip = old.index("OUTFIT_IMAGE_PROMPT =")
    i_gen = old.index("def generate_outfit_preview_images")
    i_proj = old.index("def project_root()")
    i_vis_cmt = old.index("# --- vision extraction")

    NEW_OPENROUTER = """
def _openrouter_chat_image_generation(
    *,
    model: str,
    reference_image_paths: list[Path],
    prompt: str,
    image_config: dict[str, Any] | None = None,
) -> bytes:
    \"\"\"OpenRouter Gemini image models: ``/v1/chat/completions`` + ``modalities``.\"\"\"
    if not reference_image_paths:
        raise ValueError("reference_image_paths is empty")
    key = os.environ["OPENROUTER_API_KEY"]
    headers: dict[str, str] = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-Title": os.environ.get("OPENROUTER_APP_TITLE", "Fashion outfit preview"),
    }
    referer = os.environ.get("OPENROUTER_HTTP_REFERER")
    if referer:
        headers["HTTP-Referer"] = referer

    image_parts = [{"type": "image_url", "image_url": {"url": _data_url(p)}} for p in reference_image_paths]
    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}, *image_parts],
            }
        ],
        "modalities": ["image", "text"],
    }
    if image_config:
        payload["image_config"] = image_config

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=data,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter HTTP {e.code}: {err[:4000]}") from e

    if body.get("error"):
        raise RuntimeError(f"OpenRouter API error: {body['error']}")
    msg = (body.get("choices") or [{}])[0].get("message") or {}
    images = msg.get("images") or []
    if not images:
        c = (msg.get("content") or "")[:800]
        raise ValueError(
            "No images in OpenRouter response (need image output + modalities). "
            f"message_keys={list(msg.keys())!r} content_preview={c!r}"
        )
    first = images[0]
    url: str | None = None
    if isinstance(first.get("image_url"), dict):
        url = first["image_url"].get("url")
    if not url:
        url = first.get("url")
    if not url:
        raise ValueError(f"Unexpected image entry: {first!r}")
    if url.startswith("data:"):
        return _decode_data_url_to_png_bytes(url)
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


"""

    helpers_cell = old[:i_extra]
    if "import contextlib" not in helpers_cell:
        helpers_cell = helpers_cell.replace(
            "import base64\n",
            "import base64\nimport contextlib\n",
        )
    helpers_cell += old[i_img:i_ext]
    helpers_cell += old[i_oai:i_sug]
    helpers_cell += old[i_load:i_dec]
    helpers_cell += old[i_dec:i_or]
    helpers_cell += NEW_OPENROUTER
    helpers_cell += old[i_proj:i_vis_cmt]

    extraction_cell = old[i_extra:i_img] + old[i_ext:i_outfit_sys]

    NEW_OUTFIT = '''OUTFIT_SYSTEM = """You are an expert fashion stylist. Input includes `user_query` and `wardrobe`: a JSON array where each item has `filename` and extracted attributes (`category`, colors, `style`, etc.).

Task:
- Build outfit combinations from `wardrobe` that match `user_query`.
- **Bottom**: exactly one filename in `bottom` (lower body: `bottom`, `footwear`, or similar).
- **Top / upper body**: assign `top` as either:
  - a **single string** filename (one upper garment), OR
  - a **JSON array of strings** (multiple filenames) ordered **outer layer → inner** when layering fits (e.g. jacket over shirt, coat over sweater). Use categories (`outerwear`, `top`, etc.) to order layers sensibly.
- Layering may combine outerwear + top; do not duplicate a filename in one combination.
- Skip `accessory`-only looks unless the query implies it; do not pair two accessories alone.
- Do not combine a `full_body` one-piece with other garments in the same outfit (one-piece stands alone).

Score each combination from 0.0–1.0 for (a) relevance to `user_query` and (b) fashion coherence (color, formality, silhouette, layering).

For **every** combination you **must** include **`reasons`**: a JSON array of **at least one** short string explaining why the outfit fits the query and why the score is justified (cite concrete attributes from the wardrobe items when useful).

Return ONLY valid JSON:
{"combinations": [{"top": "<filename OR [filenames...]>", "bottom": "<filename>", "score": <number>, "reasons": ["<string>", "..."]}]}

`top` must be either a string or an array of strings. `reasons` must be a **non-empty** array of strings. Filenames must match `wardrobe` exactly. Sort by descending `score`. If no valid combination exists, return {"combinations": []}.
"""


'''

    outfit_fn = old[i_sug:i_load]
    outfit_cell = NEW_OUTFIT + "\n" + outfit_fn

    NEW_GEN = r'''
def _normalize_top_filenames(combo: dict[str, Any]) -> list[str]:
    """`top` may be a string or a list of strings (layering order: outer → inner)."""
    t = combo.get("top")
    if isinstance(t, list):
        return [str(x).strip() for x in t if str(x).strip()]
    if isinstance(t, str) and t.strip():
        return [t.strip()]
    return []


def _outfit_prompt_with_reasons(base_prompt: str, combo: dict[str, Any]) -> str:
    """Append model `reasons` to the image prompt when present."""
    reasons = combo.get("reasons") or []
    if not reasons:
        return base_prompt
    bullet = "\n".join(f"- {r}" for r in reasons)
    return f"{base_prompt}\n\nStylist reasoning (honor when composing the outfit):\n{bullet}"


def _write_outfit_meta(image_path: Path, combo: dict[str, Any]) -> None:
    """Sidecar JSON next to each rendered outfit (score, top, bottom, reasons)."""
    meta = {
        "score": float(combo.get("score", 0)),
        "top": combo.get("top"),
        "bottom": combo.get("bottom"),
        "reasons": combo.get("reasons", []),
    }
    meta_path = image_path.parent / f"{image_path.stem}_meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def generate_outfit_preview_images(
    combinations: list[dict[str, Any]],
    *,
    images_dir: Path,
    outfit_image_prompt: str,
    person_image_path: Path | None = None,
    min_score: float,
    top_k: int,
    out_dir: Path,
    provider: Literal["openai", "openrouter", "anthropic"] = "openai",
    model: str = "gpt-image-1.5",
    image_config: dict[str, Any] | None = None,
    append_reasons_to_prompt: bool = True,
    write_meta: bool = True,
) -> list[Path]:
    """Reference image order: optional person, upper garments (outer→inner), then lower garment.

    When ``append_reasons_to_prompt`` is True, each combo's ``reasons`` are appended to the text prompt
    for OpenRouter / OpenAI image calls. When ``write_meta`` is True, writes ``<stem>_meta.json`` beside each PNG.
    """
    if provider == "anthropic":
        raise ValueError("provider='anthropic' is not supported for outfit preview images.")

    ranked = [c for c in combinations if float(c.get("score", 0)) >= min_score]
    ranked.sort(key=lambda c: float(c.get("score", 0)), reverse=True)
    ranked = ranked[:top_k]

    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []

    if provider == "openai":
        client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    for i, combo in enumerate(ranked):
        bot_n = combo.get("bottom")
        tops = _normalize_top_filenames(combo)
        if not tops or not bot_n:
            continue
        bot_path = images_dir / str(bot_n)
        top_paths = [images_dir / n for n in tops]
        if not bot_path.is_file():
            print("skip missing bottom:", bot_path)
            continue
        if not all(p.is_file() for p in top_paths):
            print("skip missing top file in:", top_paths)
            continue

        person_path = person_image_path if person_image_path and person_image_path.is_file() else None
        ref_paths: list[Path] = []
        if person_path:
            ref_paths.append(person_path)
        ref_paths.extend(top_paths)
        ref_paths.append(bot_path)

        path = out_dir / f"outfit_{i:02d}_{float(combo.get('score',0)):.2f}.png"

        eff_prompt = (
            _outfit_prompt_with_reasons(outfit_image_prompt, combo)
            if append_reasons_to_prompt
            else outfit_image_prompt
        )

        if provider == "openrouter":
            png = _openrouter_chat_image_generation(
                model=model,
                reference_image_paths=ref_paths,
                prompt=eff_prompt,
                image_config=image_config,
            )
            path.write_bytes(png)
            if write_meta:
                _write_outfit_meta(path, combo)
            saved.append(path)
            print("wrote", path)
            continue

        with contextlib.ExitStack() as stack:
            files = [stack.enter_context(open(p, "rb")) for p in ref_paths]
            resp = client.images.edit(
                model=model,
                image=files,
                prompt=eff_prompt,
            )
        data = resp.data[0]
        if getattr(data, "b64_json", None):
            path.write_bytes(base64.standard_b64decode(data.b64_json))
        elif getattr(data, "url", None):
            urllib.request.urlretrieve(data.url, str(path))
        else:
            raise ValueError("Image response had neither url nor b64_json")
        if write_meta:
            _write_outfit_meta(path, combo)
        saved.append(path)
        print("wrote", path)

    return saved

'''

    image_gen_cell = NEW_GEN

    md0 = """# Clothing metadata & wardrobe pipeline

**Setup:** `.env` with `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or Anthropic (`ANTHROPIC_AUTH_TOKEN` **or** `ANTHROPIC_API_KEY`). Install: `pip install -r requirements.txt`

**Notebook layout**
1. **Helpers** — imports, `ROOT`, image/JSON utilities, OpenRouter image chat, text LLM client.
2. **Vision** — `EXTRACTION_SYSTEM` + `extract_clothing_metadata`.
3. **Single-image demo** — config → display → run.
4. **Batch** — `/images` → `/metadata`.
5. **Outfits (text)** — `OUTFIT_SYSTEM` + `suggest_outfit_combinations` → run (supports layered `top` as string or array).
6. **Preview prompt** — `outfit_image_prompt_for_generation` (person vs generic model).
7. **Preview gen** — `generate_outfit_preview_images` → run (optional `PERSON_IMAGE_PATH`).
"""

    cells: list[dict] = [{"cell_type": "markdown", "metadata": {}, "source": to_lines(md0)}]
    cells.append({"cell_type": "code", "metadata": {}, "outputs": [], "execution_count": None, "source": to_lines(helpers_cell)})
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("## Vision: system prompt + `extract_clothing_metadata`")})
    cells.append({"cell_type": "code", "metadata": {}, "outputs": [], "execution_count": None, "source": to_lines(extraction_cell)})
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("### Single-image demo — config")})
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                """PROVIDER: Literal["openai", "anthropic", "openrouter"] = "openrouter"
MODEL = "openai/gpt-4o"
IMAGE_PATH = ROOT / "images" / "1.jpeg"
"""
            ),
        }
    )
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                """from IPython.display import Image as IPyImage, display

path = Path(IMAGE_PATH).expanduser().resolve()
if not path.is_file():
    raise FileNotFoundError(f"Put an image at {path} or update IMAGE_PATH")
display(IPyImage(filename=str(path)))
"""
            ),
        }
    )
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                """result = extract_clothing_metadata(path, provider=PROVIDER, model=MODEL)
print(json.dumps(result, ensure_ascii=False, indent=2))
"""
            ),
        }
    )
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("## 1. Batch metadata (`/images` → `/metadata`)")})
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                """IMAGES_DIR = ROOT / "images"
METADATA_DIR = ROOT / "metadata"
ensure_project_dirs(ROOT)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def iter_images(folder: Path) -> list[Path]:
    if not folder.is_dir():
        raise FileNotFoundError(f"Create folder and add photos: {folder}")
    return sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    )


for img_path in iter_images(IMAGES_DIR):
    meta = extract_clothing_metadata(img_path, provider=PROVIDER, model=MODEL)
    payload = {"filename": img_path.name, **meta}
    out_path = METADATA_DIR / f"{img_path.stem}.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out_path)
"""
            ),
        }
    )
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("## 2. Outfit combinations (text LLM)")})
    cells.append({"cell_type": "code", "metadata": {}, "outputs": [], "execution_count": None, "source": to_lines(outfit_cell)})
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                """USER_QUERY = "Party wear"

OUTFIT_TEXT_PROVIDER: Literal["openai", "openrouter", "anthropic"] = "openrouter"
OUTFIT_TEXT_MODEL = "openai/gpt-4o-mini"

wardrobe = load_wardrobe_from_metadata_dir(METADATA_DIR)
if not wardrobe:
    raise RuntimeError(f"No JSON in {METADATA_DIR}; run section 1 first.")

combinations = suggest_outfit_combinations(
    wardrobe,
    USER_QUERY,
    provider=OUTFIT_TEXT_PROVIDER,
    model=OUTFIT_TEXT_MODEL,
)
print(json.dumps(combinations, ensure_ascii=False, indent=2))

COMBINATIONS_PATH = ROOT / "outputs" / "combinations.json"
ensure_project_dirs(ROOT)
COMBINATIONS_PATH.write_text(json.dumps(combinations, ensure_ascii=False, indent=2), encoding="utf-8")
print("wrote", COMBINATIONS_PATH)
"""
            ),
        }
    )
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("## 3a. Preview — instruction builder (`outfit_image_prompt_for_generation`)")})
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                '''def outfit_image_prompt_for_generation(*, include_person_reference: bool) -> str:
    """Build instructions for the image model (identity preservation vs generic model)."""
    if include_person_reference:
        person = (
            "The first reference image is a photo of a real person. "
            "In the output, preserve that person's facial identity, skin tone, hair, and visible body proportions; do not substitute a different person. "
            "Dress that same individual in the garments shown in the later reference images."
        )
    else:
        person = (
            "No person reference image is provided. "
            "Depict a single plausible generic adult fashion model (professional, neutral appearance)."
        )
    garments = (
        "After any person photo, the remaining references are garments only, in order: "
        "upper-body pieces from OUTER layer to INNER (e.g. jacket then shirt), then the lower-body garment last. "
        "Match colors, patterns, and silhouette from those references."
    )
    out = (
        "Output exactly ONE photorealistic full-body fashion photograph: clean studio lighting, neutral background, natural standing pose, editorial quality."
    )
    return "\\n\\n".join([person, garments, out])

'''
            ),
        }
    )
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("## 3b. Preview — `generate_outfit_preview_images`")})
    cells.append({"cell_type": "code", "metadata": {}, "outputs": [], "execution_count": None, "source": to_lines(image_gen_cell)})
    cells.append({"cell_type": "markdown", "metadata": {}, "source": to_lines("## 3c. Preview — run")})
    cells.append(
        {
            "cell_type": "code",
            "metadata": {},
            "outputs": [],
            "execution_count": None,
            "source": to_lines(
                """SCORE_MIN = 0.8
TOP_K = 2
IMAGE_GEN_PROVIDER: Literal["openai", "openrouter", "anthropic"] = "openrouter"
IMAGE_GEN_MODEL = "google/gemini-3.1-flash-image-preview"
IMAGE_GEN_CONFIG: dict | None = {"aspect_ratio": "3:4", "image_size": "1K"}

# Optional: photo of the person to dress (omit file or use a non-existent path for a generic model)
PERSON_IMAGE_PATH = ROOT / "images" / "person.jpg"

OUTFIT_IMAGES_DIR = ROOT / "outputs" / "outfit_previews"
ensure_project_dirs(ROOT)

COMBINATIONS_PATH = ROOT / "outputs" / "combinations.json"
wardrobe = load_wardrobe_from_metadata_dir(METADATA_DIR)
combinations = json.loads(COMBINATIONS_PATH.read_text(encoding="utf-8"))

include_person = PERSON_IMAGE_PATH.is_file()
outfit_prompt = outfit_image_prompt_for_generation(include_person_reference=include_person)

saved_paths = generate_outfit_preview_images(
    combinations,
    images_dir=IMAGES_DIR,
    outfit_image_prompt=outfit_prompt,
    person_image_path=PERSON_IMAGE_PATH if include_person else None,
    min_score=SCORE_MIN,
    top_k=TOP_K,
    out_dir=OUTFIT_IMAGES_DIR,
    provider=IMAGE_GEN_PROVIDER,
    model=IMAGE_GEN_MODEL,
    image_config=IMAGE_GEN_CONFIG,
)
saved_paths
"""
            ),
        }
    )

    nb["cells"] = cells
    nb["nbformat"] = 4
    nb["nbformat_minor"] = 5
    NB.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
    print("Wrote", NB, "cells:", len(cells))


if __name__ == "__main__":
    main()
