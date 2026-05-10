from __future__ import annotations

import re
from dataclasses import dataclass

from .schemas import Chapter


@dataclass
class TextChunk:
    chunk_id: str
    textbook_id: str
    textbook_title: str
    chapter_id: str
    chapter_title: str
    page_start: int | None
    page_end: int | None
    content: str
    char_count: int
    chunk_index: int


def _split_text(text: str, chunk_size: int = 600, overlap: int = 120) -> list[str]:
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        if end < len(text):
            for sep in ("\n\n", "\n", "。", "；", ". ", "; "):
                pos = text.rfind(sep, start + chunk_size // 2, end)
                if pos > 0:
                    end = pos + 1
                    break
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end - overlap if end < len(text) else end
    return chunks


def chunk_chapter(
    chapter: Chapter,
    textbook_id: str,
    textbook_title: str,
    chunk_size: int = 600,
    overlap: int = 120,
) -> list[TextChunk]:
    texts = _split_text(chapter.content, chunk_size, overlap)
    return [
        TextChunk(
            chunk_id=f"{chapter.chapter_id}_ck_{i:03d}",
            textbook_id=textbook_id,
            textbook_title=textbook_title,
            chapter_id=chapter.chapter_id,
            chapter_title=chapter.title,
            page_start=chapter.page_start,
            page_end=chapter.page_end,
            content=t,
            char_count=len(t),
            chunk_index=i,
        )
        for i, t in enumerate(texts)
    ]


def chunk_textbook_chapters(
    chapters: list[Chapter],
    textbook_id: str,
    textbook_title: str,
    chunk_size: int = 600,
    overlap: int = 120,
) -> list[TextChunk]:
    all_chunks: list[TextChunk] = []
    for chapter in chapters:
        if not chapter.content.strip():
            continue
        all_chunks.extend(chunk_chapter(chapter, textbook_id, textbook_title, chunk_size, overlap))
    return all_chunks
