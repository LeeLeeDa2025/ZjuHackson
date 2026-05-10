from __future__ import annotations

import logging

from .chunker import chunk_textbook_chapters
from .config import get_modelscope_settings, get_rag_settings
from .modelscope_client import ModelScopeClient
from .schemas import RagQueryRequest, RagQueryResponse, SourceCitation
from .storage import TextbookStorage
from .vector_store import VectorStore

logger = logging.getLogger(__name__)

RAG_SYSTEM_PROMPT = """你是医学教材知识问答助手。请严格基于下面提供的教材原文片段回答问题。

要求：
1. 只使用提供的原文片段中的信息，不要引入外部知识。
2. 如果原文片段不足以回答问题，请明确说明"根据提供的教材内容，无法回答此问题"。
3. 回答时尽量引用原文的具体表述，并在引用处标注来源编号，例如 [1]、[2]。
4. 回答应条理清晰，先给出结论，再分点展开。
5. 如果不同教材对同一问题有不同表述，请并列呈现。"""


def _source_key(chunk: dict) -> tuple:
    return (
        chunk.get("textbook_id", ""),
        chunk.get("chapter_id", ""),
        chunk.get("page_start") or 0,
        chunk.get("page_end") or 0,
    )


def _group_chunks_by_source(chunks: list[dict]) -> list[dict]:
    grouped: dict[tuple, dict] = {}
    for chunk in chunks:
        key = _source_key(chunk)
        source = grouped.setdefault(
            key,
            {
                "textbook_id": chunk.get("textbook_id", ""),
                "textbook_title": chunk.get("textbook_title", ""),
                "chapter_id": chunk.get("chapter_id", ""),
                "chapter_title": chunk.get("chapter_title", ""),
                "page_start": chunk.get("page_start") or 0,
                "page_end": chunk.get("page_end") or 0,
                "chunk_start": chunk.get("chunk_index") or 0,
                "chunk_end": chunk.get("chunk_index") or 0,
                "score": 0.0,
                "chunks": [],
            },
        )
        source["chunks"].append(chunk)
        source["score"] = max(source["score"], chunk.get("score", 0.0))
        chunk_index = chunk.get("chunk_index") or 0
        source["chunk_start"] = min(source["chunk_start"], chunk_index)
        source["chunk_end"] = max(source["chunk_end"], chunk_index)

    sources = list(grouped.values())
    sources.sort(key=lambda item: item["score"], reverse=True)
    return sources


def _format_source_label(source: dict, index: int) -> str:
    label = f"[{index}] 《{source.get('textbook_title', '未知教材')}》"
    chapter = source.get("chapter_title", "")
    page_start = source.get("page_start") or None
    page_end = source.get("page_end") or None
    if chapter:
        label += f" {chapter}"
    if page_start and page_end and page_start != page_end:
        label += f" 第{page_start}-{page_end}页"
    elif page_start:
        label += f" 第{page_start}页"
    else:
        chunk_start = source.get("chunk_start")
        chunk_end = source.get("chunk_end")
        if chunk_start is not None and chunk_end is not None:
            label += f" 片段{chunk_start}-{chunk_end}" if chunk_start != chunk_end else f" 片段{chunk_start}"
    return label


def _build_context(sources: list[dict]) -> str:
    parts: list[str] = []
    for i, source in enumerate(sources):
        snippets = "\n".join(
            f"片段 {chunk.get('chunk_index', '')}: {chunk['content']}"
            for chunk in source["chunks"]
        )
        parts.append(f"{_format_source_label(source, i + 1)}\n{snippets}")
    return "\n\n---\n\n".join(parts)


def _build_sources(sources: list[dict]) -> list[SourceCitation]:
    return [
        SourceCitation(
            source_index=i + 1,
            textbook_id=source.get("textbook_id", ""),
            textbook_title=source.get("textbook_title", ""),
            chapter_id=source.get("chapter_id", ""),
            chapter_title=source.get("chapter_title", ""),
            page=source.get("page_start") or None,
            page_end=source.get("page_end") or None,
            chunk_start=source.get("chunk_start"),
            chunk_end=source.get("chunk_end"),
            chunk_count=len(source.get("chunks", [])),
            excerpt="\n".join(chunk["content"] for chunk in source.get("chunks", []))[:500],
            score=round(source.get("score", 0.0), 4),
        )
        for i, source in enumerate(sources)
    ]


class RagEngine:
    def __init__(self, vector_store: VectorStore, storage: TextbookStorage) -> None:
        self.vector_store = vector_store
        self.storage = storage

    async def query(self, request: RagQueryRequest) -> RagQueryResponse:
        chunks = self.vector_store.search(
            query=request.question,
            textbook_ids=request.textbook_ids or None,
            top_k=request.top_k,
        )

        if not chunks:
            return RagQueryResponse(
                question=request.question,
                answer="暂未索引任何教材内容，请先上传教材并生成知识图谱。",
                sources=[],
                model="",
            )

        sources = _group_chunks_by_source(chunks)
        context = _build_context(sources)
        messages = [
            {"role": "system", "content": RAG_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"教材原文片段：\n\n{context}\n\n用户问题：{request.question}",
            },
        ]

        settings = get_modelscope_settings()
        client = ModelScopeClient(settings)
        answer = await client.chat(messages, json_mode=False)

        return RagQueryResponse(
            question=request.question,
            answer=answer.strip(),
            sources=_build_sources(sources),
            model=settings.model,
        )

    def ensure_indexed(self, textbook_id: str) -> int:
        """Ensure a textbook is indexed; returns chunk count added."""
        if self.vector_store.has_textbook(textbook_id):
            return 0

        textbook = self.storage.get_textbook(textbook_id, include_content=True)
        if not textbook or not textbook.chapters:
            return 0

        rag_settings = get_rag_settings()
        chunks = chunk_textbook_chapters(
            textbook.chapters,
            textbook.textbook_id,
            textbook.title,
            chunk_size=rag_settings.chunk_size,
            overlap=rag_settings.chunk_overlap,
        )
        return self.vector_store.index_chunks(chunks)

    def rebuild_index(self, textbook_id: str) -> int:
        textbook = self.storage.get_textbook(textbook_id, include_content=True)
        if not textbook or not textbook.chapters:
            return 0

        rag_settings = get_rag_settings()
        chunks = chunk_textbook_chapters(
            textbook.chapters,
            textbook.textbook_id,
            textbook.title,
            chunk_size=rag_settings.chunk_size,
            overlap=rag_settings.chunk_overlap,
        )
        return self.vector_store.rebuild_for_textbook(textbook_id, chunks)

    def index_all(self) -> dict[str, int]:
        results: dict[str, int] = {}
        for summary in self.storage.list_summaries():
            if summary.status != "completed":
                continue
            count = self.ensure_indexed(summary.textbook_id)
            results[summary.textbook_id] = count
        return results
