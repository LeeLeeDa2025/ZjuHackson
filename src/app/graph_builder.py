from __future__ import annotations

import asyncio
import inspect
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable

from .config import get_modelscope_settings
from .modelscope_client import ModelScopeClient
from .schemas import Chapter, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, Textbook


RELATION_TYPES = {"prerequisite", "parallel", "contains", "applies_to"}
ProgressCallback = Callable[[dict[str, Any]], Any]


async def build_knowledge_graph(
    textbook: Textbook,
    chapter_ids: list[str] | None = None,
    max_chapters: int = 3,
    progress_callback: ProgressCallback | None = None,
) -> KnowledgeGraph:
    settings = get_modelscope_settings()
    client = ModelScopeClient(settings)
    selected_chapters = _select_chapters(textbook.chapters, chapter_ids, max_chapters)

    nodes: list[KnowledgeNode] = []
    edges: list[KnowledgeEdge] = []
    node_id_by_name: dict[str, str] = {}
    edge_keys: set[tuple[str, str, str]] = set()
    extraction_errors: list[str] = []
    semaphore = asyncio.Semaphore(settings.chapter_concurrency)
    chapter_results = await asyncio.gather(
        *[
            _extract_chapter_graph_limited(
                semaphore,
                client,
                chapter,
                settings.chunk_chars,
                settings.chunk_concurrency,
                progress_callback,
            )
            for chapter in selected_chapters
        ],
        return_exceptions=True,
    )

    for chapter, result in zip(selected_chapters, chapter_results, strict=True):
        if isinstance(result, Exception):
            error = _format_exception(result)
            extraction_errors.append(f"{chapter.title}: {error}")
            await _notify_progress(
                progress_callback,
                {
                    "event": "chapter_failed",
                    "chapter_id": chapter.chapter_id,
                    "chapter_title": chapter.title,
                    "error": error,
                },
            )
            continue

        raw_graph = result
        local_to_global: dict[str, str] = {}

        for raw_node in raw_graph.get("nodes", []):
            name = str(raw_node.get("name", "")).strip()
            if not name:
                continue

            name_key = _normalize_key(name)
            global_id = node_id_by_name.get(name_key)
            if not global_id:
                global_id = f"node_{len(nodes) + 1:03d}"
                node_id_by_name[name_key] = global_id
                nodes.append(
                    KnowledgeNode(
                        id=global_id,
                        name=name,
                        definition=str(raw_node.get("definition", "")).strip(),
                        category=str(raw_node.get("category", "核心概念")).strip() or "核心概念",
                        chapter=str(raw_node.get("chapter", chapter.title)).strip() or chapter.title,
                        page=_coerce_page(raw_node.get("page")) or chapter.page_start,
                        source_excerpt=str(raw_node.get("source_excerpt", "")).strip() or None,
                        confidence=_coerce_confidence(raw_node.get("confidence")),
                    )
                )

            local_id = str(raw_node.get("id", "")).strip()
            if local_id:
                local_to_global[local_id] = global_id
            local_to_global[name] = global_id

        for raw_edge in raw_graph.get("edges", []):
            source = _resolve_node_id(raw_edge.get("source"), local_to_global, node_id_by_name)
            target = _resolve_node_id(raw_edge.get("target"), local_to_global, node_id_by_name)
            relation_type = str(raw_edge.get("relation_type", "")).strip()
            if not source or not target or source == target or relation_type not in RELATION_TYPES:
                continue
            edge_key = (source, target, relation_type)
            if edge_key in edge_keys:
                continue
            edge_keys.add(edge_key)
            edges.append(
                KnowledgeEdge(
                    source=source,
                    target=target,
                    relation_type=relation_type,  # type: ignore[arg-type]
                    description=str(raw_edge.get("description", "")).strip(),
                )
            )

    if not nodes and extraction_errors:
        raise RuntimeError("所有章节抽取失败；" + "；".join(extraction_errors[:3]))

    return KnowledgeGraph(
        textbook_id=textbook.textbook_id,
        title=textbook.title,
        model=settings.model,
        generated_at=datetime.now(timezone.utc).isoformat(),
        chapter_count=len(selected_chapters),
        nodes=nodes,
        edges=edges,
        extraction_errors=extraction_errors,
    )


async def _extract_chapter_graph_limited(
    semaphore: asyncio.Semaphore,
    client: ModelScopeClient,
    chapter: Chapter,
    chunk_chars: int,
    chunk_concurrency: int,
    progress_callback: ProgressCallback | None,
) -> dict:
    async with semaphore:
        return await _extract_chapter_graph(client, chapter, chunk_chars, chunk_concurrency, progress_callback)


async def _extract_chapter_graph(
    client: ModelScopeClient,
    chapter: Chapter,
    chunk_chars: int,
    chunk_concurrency: int = 1,
    progress_callback: ProgressCallback | None = None,
) -> dict:
    chunks = _split_chapter_content(chapter.content, chunk_chars)
    if not chunks:
        return {"nodes": [], "edges": []}

    await _notify_progress(
        progress_callback,
        {
            "event": "chapter_started",
            "chapter_id": chapter.chapter_id,
            "chapter_title": chapter.title,
            "total_chunks": len(chunks),
        },
    )

    combined_nodes: list[dict] = []
    combined_edges: list[dict] = []
    chunk_semaphore = asyncio.Semaphore(chunk_concurrency)
    chunk_results = await asyncio.gather(
        *[
            _extract_chapter_chunk_graph_limited(
                chunk_semaphore,
                client,
                chapter,
                chunk,
                chunk_index,
                len(chunks),
                progress_callback,
            )
            for chunk_index, chunk in enumerate(chunks, start=1)
        ],
    )

    for chunk_index, raw_graph in enumerate(chunk_results, start=1):
        id_prefix = f"chunk_{chunk_index}_"
        for raw_node in raw_graph.get("nodes", []):
            node = dict(raw_node)
            node_id = str(node.get("id", "")).strip()
            if node_id:
                node["id"] = f"{id_prefix}{node_id}"
            combined_nodes.append(node)
        for raw_edge in raw_graph.get("edges", []):
            edge = dict(raw_edge)
            source = str(edge.get("source", "")).strip()
            target = str(edge.get("target", "")).strip()
            if source:
                edge["source"] = f"{id_prefix}{source}"
            if target:
                edge["target"] = f"{id_prefix}{target}"
            combined_edges.append(edge)
    await _notify_progress(
        progress_callback,
        {
            "event": "chapter_completed",
            "chapter_id": chapter.chapter_id,
            "chapter_title": chapter.title,
            "total_chunks": len(chunks),
            "completed_chunks": len(chunks),
        },
    )
    return {"nodes": combined_nodes, "edges": combined_edges}


async def _extract_chapter_chunk_graph_limited(
    semaphore: asyncio.Semaphore,
    client: ModelScopeClient,
    chapter: Chapter,
    content: str,
    chunk_index: int,
    chunk_count: int,
    progress_callback: ProgressCallback | None,
) -> dict:
    async with semaphore:
        raw_graph = await _extract_chapter_chunk_graph(client, chapter, content, chunk_index, chunk_count)
        await _notify_progress(
            progress_callback,
            {
                "event": "chunk_completed",
                "chapter_id": chapter.chapter_id,
                "chapter_title": chapter.title,
                "chunk_index": chunk_index,
                "total_chunks": chunk_count,
            },
        )
        return raw_graph


async def _extract_chapter_chunk_graph(
    client: ModelScopeClient,
    chapter: Chapter,
    content: str,
    chunk_index: int,
    chunk_count: int,
) -> dict:
    messages = [
        {
            "role": "system",
            "content": (
                "你是医学教材知识图谱抽取助手。只输出合法 JSON，不要输出 Markdown。"
                "知识点要覆盖概念、定理、方法、现象、结构、功能和临床应用。"
            ),
        },
        {
            "role": "user",
            "content": f"""
请从下面一个教材章节片段中抽取知识图谱节点和关系。

输出必须是如下 JSON 对象：
{{
  "nodes": [
    {{
      "id": "node_001",
      "name": "动作电位",
      "definition": "细胞受到刺激后，膜电位发生的一次快速而可逆的倒转。",
      "category": "核心概念",
      "chapter": "{chapter.title}",
      "page": {chapter.page_start or "null"},
      "source_excerpt": "该知识点在原文中对应的一句或短语",
      "confidence": 0.92
    }}
  ],
  "edges": [
    {{
      "source": "node_001",
      "target": "node_002",
      "relation_type": "prerequisite",
      "description": "理解动作电位需要先掌握静息电位的概念"
    }}
  ]
}}

few-shot 示例：
输入片段：
"细胞在安静状态下存在静息电位。受到有效刺激后，膜电位可快速去极化并形成动作电位。动作电位的产生依赖 Na+ 通道开放，随后 K+ 外流参与复极。"

输出示例：
{{
  "nodes": [
    {{
      "id": "node_001",
      "name": "静息电位",
      "definition": "细胞安静状态下膜两侧存在的电位差。",
      "category": "核心概念",
      "chapter": "{chapter.title}",
      "page": {chapter.page_start or "null"},
      "source_excerpt": "细胞在安静状态下存在静息电位",
      "confidence": 0.95
    }},
    {{
      "id": "node_002",
      "name": "动作电位",
      "definition": "有效刺激引起膜电位快速去极化形成的电位变化。",
      "category": "核心概念",
      "chapter": "{chapter.title}",
      "page": {chapter.page_start or "null"},
      "source_excerpt": "受到有效刺激后，膜电位可快速去极化并形成动作电位",
      "confidence": 0.93
    }},
    {{
      "id": "node_003",
      "name": "Na+ 通道开放",
      "definition": "动作电位产生过程中钠离子通道开放的现象。",
      "category": "生理机制",
      "chapter": "{chapter.title}",
      "page": {chapter.page_start or "null"},
      "source_excerpt": "动作电位的产生依赖 Na+ 通道开放",
      "confidence": 0.9
    }}
  ],
  "edges": [
    {{
      "source": "node_001",
      "target": "node_002",
      "relation_type": "prerequisite",
      "description": "理解动作电位需要先掌握静息电位"
    }},
    {{
      "source": "node_003",
      "target": "node_002",
      "relation_type": "applies_to",
      "description": "Na+ 通道开放用于解释动作电位产生机制"
    }}
  ]
}}

关系类型只能从以下四种选择：
- prerequisite：学习 B 之前必须先掌握 A
- parallel：同一层级的平行概念
- contains：上位概念与下位概念
- applies_to：某知识点是另一个的应用场景

要求：
- 每个片段抽取 6 到 14 个高价值知识点。
- 节点 id 从 node_001 顺序编号。
- 边的 source/target 必须引用本次输出中的节点 id。
- 定义要简洁，避免整段照抄原文。
- source_excerpt 只能摘取一句关键原文或短语，用于用户点击节点时定位出处。
- confidence 表示该节点来自原文证据的可信度，范围 0 到 1；证据明确时接近 1，推断较多时降低。

章节标题：{chapter.title}
章节片段：{chunk_index}/{chunk_count}
页码范围：{chapter.page_start or "未知"} - {chapter.page_end or "未知"}

片段正文：
{content}
""".strip(),
        },
    ]
    return _parse_json_object(await client.chat(messages))


def _split_chapter_content(content: str, chunk_chars: int) -> list[str]:
    clean = content.strip()
    if not clean:
        return []
    if len(clean) <= chunk_chars:
        return [clean]

    chunks: list[str] = []
    start = 0
    while start < len(clean):
        end = min(start + chunk_chars, len(clean))
        if end < len(clean):
            split_at = max(clean.rfind("\n", start, end), clean.rfind("。", start, end), clean.rfind("；", start, end))
            if split_at > start + chunk_chars * 0.55:
                end = split_at + 1
        chunks.append(clean[start:end].strip())
        start = end
    return [chunk for chunk in chunks if chunk]


def _select_chapters(chapters: list[Chapter], chapter_ids: list[str] | None, max_chapters: int) -> list[Chapter]:
    if chapter_ids:
        wanted = set(chapter_ids)
        selected = [chapter for chapter in chapters if chapter.chapter_id in wanted]
    else:
        selected = chapters[:max_chapters]
    return [chapter for chapter in selected if chapter.content.strip()]


def _parse_json_object(text: str) -> dict:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if not match:
            raise
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("Knowledge graph response must be a JSON object.")
    return data


def _resolve_node_id(value: object, local_to_global: dict[str, str], node_id_by_name: dict[str, str]) -> str | None:
    key = str(value or "").strip()
    if not key:
        return None
    return local_to_global.get(key) or node_id_by_name.get(_normalize_key(key))


def _normalize_key(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def _coerce_page(value: object) -> int | None:
    if value is None:
        return None
    try:
        page = int(value)
    except (TypeError, ValueError):
        return None
    return page if page > 0 else None


def _coerce_confidence(value: object) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 1.0
    return max(0.0, min(confidence, 1.0))


def _format_exception(exc: Exception) -> str:
    message = str(exc).strip() or repr(exc)
    return f"{type(exc).__name__}: {message}"


async def _notify_progress(progress_callback: ProgressCallback | None, payload: dict[str, Any]) -> None:
    if progress_callback is None:
        return
    result = progress_callback(payload)
    if inspect.isawaitable(result):
        await result
