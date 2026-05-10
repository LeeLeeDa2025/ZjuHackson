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


def _build_context(chunks: list[dict]) -> str:
    parts: list[str] = []
    for i, chunk in enumerate(chunks):
        source = f"[{i + 1}] 《{chunk.get('textbook_title', '未知教材')}》"
        chapter = chunk.get("chapter_title", "")
        page = chunk.get("page_start", "")
        if chapter:
            source += f" {chapter}"
        if page and page != 0:
            source += f" 第{page}页"
        parts.append(f"{source}\n{chunk['content']}")
    return "\n\n---\n\n".join(parts)


def _build_sources(chunks: list[dict]) -> list[SourceCitation]:
    return [
        SourceCitation(
            source_index=i + 1,
            textbook_id=chunk.get("textbook_id", ""),
            textbook_title=chunk.get("textbook_title", ""),
            chapter_id=chunk.get("chapter_id", ""),
            chapter_title=chunk.get("chapter_title", ""),
            page=chunk.get("page_start") or None,
            excerpt=chunk["content"][:300],
            score=round(chunk.get("score", 0.0), 4),
        )
        for i, chunk in enumerate(chunks)
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

        context = _build_context(chunks)
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
            sources=_build_sources(chunks),
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
