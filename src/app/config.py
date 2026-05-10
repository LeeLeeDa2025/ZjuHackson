from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def load_local_env(path: Path | None = None) -> None:
    env_path = path or PROJECT_ROOT / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lstrip("\ufeff")
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True)
class ModelScopeSettings:
    api_key: str | None
    api_base: str
    model: str
    timeout_seconds: float
    max_chars_per_chapter: int
    chapter_concurrency: int

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    @property
    def masked_api_key(self) -> str | None:
        if not self.api_key:
            return None
        if len(self.api_key) <= 8:
            return "*" * len(self.api_key)
        return f"{self.api_key[:4]}...{self.api_key[-4:]}"


def get_modelscope_settings() -> ModelScopeSettings:
    load_local_env()
    api_key = os.getenv("MODELSCOPE_API_KEY") or os.getenv("MODELSCOPE_ACCESS_TOKEN")
    return ModelScopeSettings(
        api_key=api_key,
        api_base=os.getenv("MODELSCOPE_API_BASE", "https://api-inference.modelscope.cn/v1").rstrip("/"),
        model=os.getenv("MODELSCOPE_MODEL", "Qwen/Qwen3-30B-A3B-Instruct-2507"),
        timeout_seconds=float(os.getenv("MODELSCOPE_TIMEOUT_SECONDS", "120")),
        max_chars_per_chapter=int(os.getenv("KG_MAX_CHARS_PER_CHAPTER", "12000")),
        chapter_concurrency=max(1, int(os.getenv("KG_CHAPTER_CONCURRENCY", "3"))),
    )
