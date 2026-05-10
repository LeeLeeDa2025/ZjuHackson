from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PLACEHOLDER_API_KEYS = {
    "",
    "your_modelscope_api_key_here",
    "your_api_key_here",
    "your_key_here",
    "sk-xxx",
}


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
    chunk_chars: int
    chapter_concurrency: int
    chunk_concurrency: int
    max_retries: int

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


@dataclass(frozen=True)
class RagSettings:
    chunk_size: int
    chunk_overlap: int
    top_k: int
    embedding_model: str


def get_rag_settings() -> RagSettings:
    load_local_env()
    return RagSettings(
        chunk_size=int(os.getenv("RAG_CHUNK_SIZE", "600")),
        chunk_overlap=int(os.getenv("RAG_CHUNK_OVERLAP", "120")),
        top_k=int(os.getenv("RAG_TOP_K", "5")),
        embedding_model=os.getenv("RAG_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5"),
    )


def get_modelscope_settings() -> ModelScopeSettings:
    load_local_env()
    api_key = _normalize_api_key(os.getenv("MODELSCOPE_API_KEY") or os.getenv("MODELSCOPE_ACCESS_TOKEN"))
    return ModelScopeSettings(
        api_key=api_key,
        api_base=os.getenv("MODELSCOPE_API_BASE", "https://api-inference.modelscope.cn/v1").rstrip("/"),
        model=os.getenv("MODELSCOPE_MODEL", "Qwen/Qwen3-30B-A3B-Instruct-2507"),
        timeout_seconds=float(os.getenv("MODELSCOPE_TIMEOUT_SECONDS", "120")),
        chunk_chars=int(os.getenv("KG_CHUNK_CHARS", os.getenv("KG_MAX_CHARS_PER_CHAPTER", "8000"))),
        chapter_concurrency=max(1, int(os.getenv("KG_CHAPTER_CONCURRENCY", "1"))),
        chunk_concurrency=max(1, int(os.getenv("KG_CHUNK_CONCURRENCY", "2"))),
        max_retries=max(0, int(os.getenv("MODELSCOPE_MAX_RETRIES", "2"))),
    )


def _normalize_api_key(value: str | None) -> str | None:
    if value is None:
        return None
    api_key = value.strip()
    if api_key.lower() in PLACEHOLDER_API_KEYS:
        return None
    return api_key
