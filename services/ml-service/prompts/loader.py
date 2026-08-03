"""
Prompt template loader for VIDA ML Service.

Loads versioned prompt templates from the prompts/ directory at startup.
Templates use YAML frontmatter for metadata and Markdown for content,
with separate system and user prompt sections.
"""

import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger("prompt_loader")

PROMPTS_DIR = Path(__file__).parent

# Cached templates: { "stage5_risk_narrative_v1.7.0": { "metadata": {...}, "system": "...", "user_template": "..." } }
_cache: dict[str, dict[str, Any]] = {}


def _parse_frontmatter(content: str) -> tuple[dict[str, str], str]:
    """Extract YAML-like frontmatter and body from a markdown file."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if not match:
        return {}, content

    meta = {}
    for line in match.group(1).strip().splitlines():
        if ":" in line:
            key, val = line.split(":", 1)
            meta[key.strip()] = val.strip().strip('"').strip("'")
    return meta, match.group(2)


def _parse_sections(body: str) -> tuple[str, str]:
    """Split body into system prompt and user prompt template sections."""
    parts = re.split(r"^#\s+User Prompt Template\s*$", body, flags=re.MULTILINE)
    if len(parts) == 2:
        system_raw = parts[0]
        user_raw = parts[1]
    else:
        system_raw = body
        user_raw = ""

    # Strip the "# System Prompt" header from system section
    system_raw = re.sub(r"^#\s+System Prompt\s*\n", "", system_raw, flags=re.MULTILINE)

    return system_raw.strip(), user_raw.strip()


def load_prompt(name: str) -> dict[str, Any]:
    """
    Load a prompt template by name (without .md extension).

    Returns dict with keys: metadata, system, user_template.
    Raises FileNotFoundError if the template does not exist.
    """
    if name in _cache:
        return _cache[name]

    path = PROMPTS_DIR / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"Prompt template not found: {path}")

    content = path.read_text(encoding="utf-8")
    metadata, body = _parse_frontmatter(content)
    system_prompt, user_template = _parse_sections(body)

    template = {
        "metadata": metadata,
        "system": system_prompt,
        "user_template": user_template,
    }
    _cache[name] = template
    logger.info(
        "Loaded prompt template '%s' (version %s)", name, metadata.get("version", "?")
    )
    return template


def render_user_prompt(name: str, **kwargs: Any) -> str:
    """
    Load a prompt template and render the user prompt with the given variables.

    Uses str.format_map with a defaulting dict so missing keys render as
    '{key_name}' instead of raising KeyError.
    """
    template = load_prompt(name)

    class DefaultDict(dict):
        def __missing__(self, key):
            return f"{{{key}}}"

    return template["user_template"].format_map(DefaultDict(**kwargs))


def get_system_prompt(name: str) -> str:
    """Return the system prompt for a given template name."""
    return load_prompt(name)["system"]


def get_model_config(name: str) -> dict[str, Any]:
    """Return model and max_tokens from template metadata."""
    meta = load_prompt(name)["metadata"]
    return {
        "model": meta.get("model", "claude-sonnet-4-20250514"),
        "max_tokens": int(meta.get("max_tokens", "1200")),
    }


def preload_all() -> list[str]:
    """Load all .md prompt templates in the prompts directory. Returns list of loaded names."""
    loaded = []
    for path in PROMPTS_DIR.glob("*.md"):
        name = path.stem
        try:
            load_prompt(name)
            loaded.append(name)
        except Exception as e:
            logger.warning("Failed to load prompt '%s': %s", name, e)
    return loaded
