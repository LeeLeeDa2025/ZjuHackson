from __future__ import annotations

import asyncio
import hashlib
import re
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import get_modelscope_settings
from .graph_builder import _split_chapter_content, build_knowledge_graph
from .modelscope_client import ModelScopeNotConfiguredError
from .parser import UnsupportedFormatError, parse_textbook
from .rag_engine import RagEngine
from .schemas import (
    KnowledgeGraph,
    KnowledgeGraphBuildRequest,
    RagIndexResult,
    RagQueryRequest,
    RagQueryResponse,
    Textbook,
    TextbookSummary,
    UploadResult,
)
from .storage import TextbookStorage
from .vector_store import VectorStore


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = PROJECT_ROOT / "data"
STATIC_ROOT = PROJECT_ROOT / "src" / "web"
SUPPORTED_SUFFIXES = {".pdf", ".md", ".markdown", ".txt", ".docx"}

app = FastAPI(title="学科知识整合智能体", version="0.2.0")
storage = TextbookStorage(DATA_ROOT)
vector_store = VectorStore(DATA_ROOT / "vector_store")
rag_engine = RagEngine(vector_store, storage)
graph_jobs: dict[str, dict] = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if STATIC_ROOT.exists():
    app.mount("/static", StaticFiles(directory=STATIC_ROOT), name="static")


@app.get("/")
def index() -> FileResponse:
    index_path = STATIC_ROOT / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend is not built yet.")
    return FileResponse(index_path)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config/modelscope")
def modelscope_config() -> dict[str, str | bool | None]:
    settings = get_modelscope_settings()
    return {
        "configured": settings.is_configured,
        "api_base": settings.api_base,
        "model": settings.model,
        "api_key": settings.masked_api_key,
    }


@app.post("/api/textbooks/upload", response_model=UploadResult)
async def upload_textbooks(files: list[UploadFile] = File(...)) -> UploadResult:
    results: list[TextbookSummary] = []

    for file in files:
        filename = file.filename or "untitled"
        suffix = Path(filename).suffix.lower()
        file_format = suffix.lstrip(".") or "unknown"
        provisional_id = _make_textbook_id(filename)
        provisional_path = storage.upload_path(provisional_id, filename)
        size, file_hash = await _write_upload_file(file, provisional_path)
        existing_id = storage.find_by_hash(file_hash)
        textbook_id = existing_id or provisional_id
        upload_path = _settle_upload_path(provisional_id, textbook_id, filename, provisional_path)

        if suffix not in SUPPORTED_SUFFIXES:
            storage.save_failed(textbook_id, filename, file_format, size, "不支持的文件格式", file_hash=file_hash)
            summary = storage.get_summary(textbook_id)
            if summary:
                results.append(summary)
            continue

        try:
            textbook = parse_textbook(upload_path, textbook_id, filename)
            storage.save_textbook(textbook, size=size, file_hash=file_hash)
        except UnsupportedFormatError as exc:
            storage.save_failed(textbook_id, filename, file_format, size, str(exc), file_hash=file_hash)
        except Exception as exc:  # noqa: BLE001 - keep upload endpoint resilient for batch files.
            storage.save_failed(textbook_id, filename, file_format, size, f"解析失败：{exc}", file_hash=file_hash)

        summary = storage.get_summary(textbook_id)
        if summary:
            results.append(summary)

    return UploadResult(files=results)


@app.get("/api/textbooks", response_model=list[TextbookSummary])
def list_textbooks() -> list[TextbookSummary]:
    return storage.list_summaries()


@app.get("/api/knowledge-graph")
def get_aggregate_knowledge_graph() -> dict:
    graphs = storage.list_knowledge_graphs()
    return _aggregate_knowledge_graphs(graphs)


@app.get("/api/textbooks/{textbook_id}", response_model=Textbook)
def get_textbook(textbook_id: str, include_content: bool = False) -> Textbook:
    textbook = storage.get_textbook(textbook_id, include_content=include_content)
    if textbook is None:
        raise HTTPException(status_code=404, detail="Textbook not found")
    return textbook


@app.get("/api/textbooks/{textbook_id}/export", response_model=Textbook)
def export_textbook(textbook_id: str) -> Textbook:
    textbook = storage.get_textbook(textbook_id, include_content=True)
    if textbook is None:
        raise HTTPException(status_code=404, detail="Textbook not found")
    return textbook


@app.get("/api/textbooks/{textbook_id}/knowledge-graph", response_model=KnowledgeGraph)
def get_knowledge_graph(textbook_id: str) -> KnowledgeGraph:
    graph = storage.get_knowledge_graph(textbook_id)
    if graph is None:
        raise HTTPException(status_code=404, detail="Knowledge graph not found")
    return graph


@app.post("/api/textbooks/{textbook_id}/knowledge-graph", response_model=KnowledgeGraph)
async def create_knowledge_graph(
    textbook_id: str,
    request: KnowledgeGraphBuildRequest = Body(default_factory=KnowledgeGraphBuildRequest),
) -> KnowledgeGraph:
    cached = storage.get_knowledge_graph(textbook_id)
    if cached is not None and not request.force and not request.chapter_ids:
        return cached

    textbook = storage.get_textbook(textbook_id, include_content=True)
    if textbook is None:
        raise HTTPException(status_code=404, detail="Textbook not found")
    if not textbook.chapters:
        raise HTTPException(status_code=400, detail="Textbook has no parsed chapters")

    try:
        graph = await build_knowledge_graph(
            textbook,
            chapter_ids=request.chapter_ids,
            max_chapters=request.max_chapters,
        )
    except ModelScopeNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface LLM errors to the UI.
        raise HTTPException(status_code=502, detail=f"Knowledge graph generation failed: {exc}") from exc

    storage.save_knowledge_graph(graph)

    # Auto-index the textbook for RAG queries
    try:
        rag_engine.rebuild_index(textbook_id)
    except Exception:
        pass

    return graph


@app.post("/api/textbooks/{textbook_id}/knowledge-graph/jobs")
async def start_knowledge_graph_job(
    textbook_id: str,
    request: KnowledgeGraphBuildRequest = Body(default_factory=KnowledgeGraphBuildRequest),
) -> dict:
    textbook = storage.get_textbook(textbook_id, include_content=True)
    if textbook is None:
        raise HTTPException(status_code=404, detail="Textbook not found")
    if not textbook.chapters:
        raise HTTPException(status_code=400, detail="Textbook has no parsed chapters")

    settings = get_modelscope_settings()
    selected_chapters = _select_build_chapters(textbook, request)
    if not selected_chapters:
        raise HTTPException(status_code=400, detail="No chapters selected")

    job_id = uuid.uuid4().hex
    chapters = [
        {
            "chapter_id": chapter.chapter_id,
            "title": chapter.title,
            "status": "pending",
            "chunks_done": 0,
            "chunks_total": len(_split_chapter_content(chapter.content, settings.chunk_chars)),
            "error": None,
        }
        for chapter in selected_chapters
    ]
    graph_jobs[job_id] = {
        "job_id": job_id,
        "textbook_id": textbook_id,
        "title": textbook.title,
        "status": "queued",
        "progress": 0,
        "message": "等待开始",
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "chapters": chapters,
        "graph": None,
        "error": None,
    }
    asyncio.create_task(_run_knowledge_graph_job(job_id, textbook, request))
    return graph_jobs[job_id]


@app.get("/api/knowledge-graph/jobs/{job_id}")
def get_knowledge_graph_job(job_id: str) -> dict:
    job = graph_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Knowledge graph job not found")
    return job


@app.delete("/api/textbooks/{textbook_id}")
def delete_textbook(textbook_id: str) -> dict[str, bool]:
    removed = storage.delete_textbook(textbook_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Textbook not found")
    vector_store.remove_textbook(textbook_id)
    return {"deleted": True}


async def _run_knowledge_graph_job(job_id: str, textbook: Textbook, request: KnowledgeGraphBuildRequest) -> None:
    job = graph_jobs[job_id]
    job["status"] = "running"
    job["message"] = "开始抽取知识点"
    job["updated_at"] = _now_iso()

    async def progress_callback(event: dict) -> None:
        _apply_graph_job_progress(job, event)

    try:
        graph = await build_knowledge_graph(
            textbook,
            chapter_ids=request.chapter_ids,
            max_chapters=request.max_chapters,
            progress_callback=progress_callback,
        )
        storage.save_knowledge_graph(graph)
        try:
            rag_engine.rebuild_index(textbook.textbook_id)
        except Exception:
            pass

        job["status"] = "completed"
        job["progress"] = 100
        job["message"] = f"完成：{len(graph.nodes)} 个知识点，{len(graph.edges)} 条关系"
        job["graph"] = graph.model_dump()
        job["updated_at"] = _now_iso()
    except Exception as exc:  # noqa: BLE001 - job endpoint exposes the build error to the UI.
        job["status"] = "failed"
        job["error"] = str(exc).strip() or repr(exc)
        job["message"] = f"生成失败：{job['error']}"
        job["updated_at"] = _now_iso()
        _recalculate_graph_job_progress(job)


def _select_build_chapters(textbook: Textbook, request: KnowledgeGraphBuildRequest) -> list:
    chapters = [chapter for chapter in textbook.chapters if chapter.content.strip()]
    if request.chapter_ids:
        wanted = set(request.chapter_ids)
        return [chapter for chapter in chapters if chapter.chapter_id in wanted]
    return chapters[: request.max_chapters]


def _apply_graph_job_progress(job: dict, event: dict) -> None:
    chapter = next((item for item in job["chapters"] if item["chapter_id"] == event.get("chapter_id")), None)
    if chapter is None:
        return

    if event["event"] == "chapter_started":
        chapter["status"] = "running"
        chapter["chunks_total"] = event.get("total_chunks") or chapter["chunks_total"]
        job["message"] = f"正在抽取：{chapter['title']}"
    elif event["event"] == "chunk_completed":
        chapter["status"] = "running"
        chapter["chunks_total"] = event.get("total_chunks") or chapter["chunks_total"]
        chapter["chunks_done"] = min(chapter["chunks_total"], chapter["chunks_done"] + 1)
        job["message"] = f"{chapter['title']}：{chapter['chunks_done']}/{chapter['chunks_total']} 个片段"
    elif event["event"] == "chapter_completed":
        chapter["status"] = "completed"
        chapter["chunks_total"] = event.get("total_chunks") or chapter["chunks_total"]
        chapter["chunks_done"] = chapter["chunks_total"]
        job["message"] = f"已完成章节：{chapter['title']}"
    elif event["event"] == "chapter_failed":
        chapter["status"] = "failed"
        chapter["error"] = event.get("error") or "章节抽取失败"
        job["message"] = f"章节失败：{chapter['title']}"

    job["updated_at"] = _now_iso()
    _recalculate_graph_job_progress(job)


def _recalculate_graph_job_progress(job: dict) -> None:
    total = sum(max(item["chunks_total"], 1) for item in job["chapters"])
    done = sum(item["chunks_done"] for item in job["chapters"])
    failed = sum(max(item["chunks_total"], 1) for item in job["chapters"] if item["status"] == "failed")
    job["progress"] = round(((done + failed) / total) * 100) if total else 0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── RAG endpoints ──


@app.post("/api/rag/query", response_model=RagQueryResponse)
async def rag_query(request: RagQueryRequest) -> RagQueryResponse:
    try:
        return await rag_engine.query(request)
    except ModelScopeNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"RAG query failed: {exc}") from exc


@app.post("/api/rag/index/{textbook_id}", response_model=RagIndexResult)
def rag_index_textbook(textbook_id: str) -> RagIndexResult:
    textbook = storage.get_textbook(textbook_id)
    if textbook is None:
        raise HTTPException(status_code=404, detail="Textbook not found")
    count = rag_engine.rebuild_index(textbook_id)
    return RagIndexResult(indexed={textbook_id: count}, total_chunks=vector_store.chunk_count)


@app.post("/api/rag/index-all", response_model=RagIndexResult)
def rag_index_all() -> RagIndexResult:
    indexed = rag_engine.index_all()
    return RagIndexResult(indexed=indexed, total_chunks=vector_store.chunk_count)


@app.get("/api/rag/status")
def rag_status() -> dict:
    summaries = storage.list_summaries()
    indexed_textbooks: dict[str, bool] = {}
    for summary in summaries:
        if summary.status == "completed":
            indexed_textbooks[summary.textbook_id] = vector_store.has_textbook(summary.textbook_id)
    return {
        "total_chunks": vector_store.chunk_count,
        "textbook_count": len(summaries),
        "indexed_textbooks": indexed_textbooks,
    }


# ── Internal helpers ──


async def _write_upload_file(file: UploadFile, path: Path) -> tuple[int, str]:
    size = 0
    digest = hashlib.sha256()
    with path.open("wb") as target:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
            target.write(chunk)
    return size, digest.hexdigest()


def _settle_upload_path(provisional_id: str, textbook_id: str, filename: str, provisional_path: Path) -> Path:
    if provisional_id == textbook_id:
        return provisional_path

    final_path = storage.upload_path(textbook_id, filename)
    if final_path.parent.exists():
        shutil.rmtree(final_path.parent)
    final_path.parent.mkdir(parents=True, exist_ok=True)
    provisional_path.replace(final_path)
    provisional_dir = storage.uploads_dir / provisional_id
    if provisional_dir.exists():
        provisional_dir.rmdir()
    return final_path


def _make_textbook_id(filename: str) -> str:
    safe_stem = "".join(char.lower() if char.isalnum() else "_" for char in Path(filename).stem)[:24].strip("_")
    suffix = int(time.time() * 1000)
    unique = uuid.uuid4().hex[:8]
    return f"book_{suffix}_{unique}_{safe_stem or 'textbook'}"


def _aggregate_knowledge_graphs(graphs: list[KnowledgeGraph]) -> dict:
    node_by_key: dict[str, dict] = {}
    source_to_key: dict[tuple[str, str], str] = {}

    for graph in graphs:
        for node in graph.nodes:
            key = _knowledge_key(node.name)
            if not key:
                continue
            aggregate = node_by_key.setdefault(
                key,
                {
                    "id": f"agg_node_{len(node_by_key) + 1:03d}",
                    "name": node.name,
                    "definition": node.definition,
                    "category": node.category,
                    "frequency": 0,
                    "textbook_count": 0,
                    "textbook_ids": [],
                    "textbook_titles": [],
                    "sources": [],
                },
            )
            aggregate["frequency"] += 1
            if len(node.definition) > len(aggregate.get("definition", "")):
                aggregate["definition"] = node.definition
            if graph.textbook_id not in aggregate["textbook_ids"]:
                aggregate["textbook_ids"].append(graph.textbook_id)
                aggregate["textbook_titles"].append(graph.title)
                aggregate["textbook_count"] += 1
            aggregate["sources"].append(
                {
                    "textbook_id": graph.textbook_id,
                    "textbook_title": graph.title,
                    "chapter": node.chapter,
                    "page": node.page,
                    "definition": node.definition,
                    "source_excerpt": node.source_excerpt,
                    "node_id": node.id,
                }
            )
            source_to_key[(graph.textbook_id, node.id)] = key

    edges_by_key: dict[tuple[str, str, str], dict] = {}
    for graph in graphs:
        for edge in graph.edges:
            source_key = source_to_key.get((graph.textbook_id, edge.source))
            target_key = source_to_key.get((graph.textbook_id, edge.target))
            if not source_key or not target_key or source_key == target_key:
                continue
            source_id = node_by_key[source_key]["id"]
            target_id = node_by_key[target_key]["id"]
            edge_key = (source_id, target_id, edge.relation_type)
            aggregate = edges_by_key.setdefault(
                edge_key,
                {
                    "source": source_id,
                    "target": target_id,
                    "relation_type": edge.relation_type,
                    "description": edge.description,
                    "frequency": 0,
                    "textbook_ids": [],
                    "textbook_titles": [],
                },
            )
            aggregate["frequency"] += 1
            if graph.textbook_id not in aggregate["textbook_ids"]:
                aggregate["textbook_ids"].append(graph.textbook_id)
                aggregate["textbook_titles"].append(graph.title)

    return {
        "textbook_count": len(graphs),
        "nodes": list(node_by_key.values()),
        "edges": list(edges_by_key.values()),
    }


def _knowledge_key(name: str) -> str:
    return re.sub(r"[\s\u3000:：,，.。;；()（）《》<>]+", "", name).lower()
