from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

from .chunker import TextChunk

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5"


class VectorStore:
    def __init__(self, persist_dir: Path) -> None:
        self.persist_dir = persist_dir
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        self._model: SentenceTransformer | None = None

    def _get_model(self) -> SentenceTransformer:
        if self._model is None:
            self._model = SentenceTransformer(EMBEDDING_MODEL)
        return self._model

    @property
    def chunk_count(self) -> int:
        total = 0
        for meta_path in sorted(self.persist_dir.glob("*/meta.json")):
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                total += len(data.get("chunks", []))
            except (json.JSONDecodeError, OSError):
                pass
        return total

    def _textbook_dir(self, textbook_id: str) -> Path:
        directory = self.persist_dir / textbook_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def has_textbook(self, textbook_id: str) -> bool:
        return (self._textbook_dir(textbook_id) / "meta.json").exists()

    def index_chunks(self, chunks: list[TextChunk]) -> int:
        if not chunks:
            return 0
        model = self._get_model()
        texts = [c.content for c in chunks]
        embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)

        textbook_id = chunks[0].textbook_id
        directory = self._textbook_dir(textbook_id)

        chunk_records = [
            {
                "chunk_id": c.chunk_id,
                "textbook_id": c.textbook_id,
                "textbook_title": c.textbook_title,
                "chapter_id": c.chapter_id,
                "chapter_title": c.chapter_title,
                "page_start": c.page_start or 0,
                "page_end": c.page_end or 0,
                "chunk_index": c.chunk_index,
                "char_count": c.char_count,
                "content": c.content,
            }
            for c in chunks
        ]

        meta_path = directory / "meta.json"
        existing = {}
        if meta_path.exists():
            try:
                existing = json.loads(meta_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass

        existing["textbook_id"] = textbook_id
        existing["chunk_count"] = len(chunks)
        existing["chunks"] = chunk_records

        meta_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
        np.save(directory / "embeddings.npy", embeddings.astype(np.float32))
        return len(chunks)

    def remove_textbook(self, textbook_id: str) -> int:
        directory = self._textbook_dir(textbook_id)
        if not directory.exists():
            return 0
        meta_path = directory / "meta.json"
        count = 0
        if meta_path.exists():
            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                count = len(data.get("chunks", []))
            except (json.JSONDecodeError, OSError):
                pass
        for item in directory.iterdir():
            item.unlink()
        directory.rmdir()
        return count

    def search(
        self,
        query: str,
        textbook_ids: list[str] | None = None,
        top_k: int = 5,
    ) -> list[dict]:
        model = self._get_model()
        query_vec = model.encode([query], normalize_embeddings=True, show_progress_bar=False)[0]

        all_items: list[dict] = []

        directories = (
            [self.persist_dir / tid for tid in textbook_ids if (self.persist_dir / tid).exists()]
            if textbook_ids
            else sorted(self.persist_dir.glob("*/"))
        )

        for directory in directories:
            if not directory.is_dir():
                continue
            meta_path = directory / "meta.json"
            emb_path = directory / "embeddings.npy"
            if not meta_path.exists() or not emb_path.exists():
                continue

            try:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                embeddings = np.load(emb_path)
            except (json.JSONDecodeError, OSError, ValueError):
                continue

            chunks = data.get("chunks", [])
            if len(chunks) != len(embeddings):
                continue

            similarities = np.dot(embeddings, query_vec)
            top_indices = np.argsort(similarities)[-top_k:][::-1]

            for idx in top_indices:
                chunk = dict(chunks[idx])
                score = float(similarities[idx])
                all_items.append(
                    {
                        "chunk_id": chunk.get("chunk_id", ""),
                        "content": chunk.pop("content", ""),
                        "score": max(0.0, score),
                        **chunk,
                    }
                )

        all_items.sort(key=lambda x: x["score"], reverse=True)
        return all_items[:top_k]

    def rebuild_for_textbook(self, textbook_id: str, chunks: list[TextChunk]) -> int:
        self.remove_textbook(textbook_id)
        return self.index_chunks(chunks)
