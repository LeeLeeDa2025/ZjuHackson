from __future__ import annotations

import json
import shutil
from pathlib import Path

from .schemas import Chapter, KnowledgeGraph, Textbook, TextbookSummary


class TextbookStorage:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.uploads_dir = root / "uploads"
        self.parsed_dir = root / "parsed"
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.parsed_dir.mkdir(parents=True, exist_ok=True)

    def upload_path(self, textbook_id: str, filename: str) -> Path:
        upload_dir = self.uploads_dir / textbook_id
        upload_dir.mkdir(parents=True, exist_ok=True)
        safe_name = Path(filename).name
        return upload_dir / safe_name

    def save_upload(self, textbook_id: str, filename: str, data: bytes) -> Path:
        path = self.upload_path(textbook_id, filename)
        path.write_bytes(data)
        return path

    def save_textbook(
        self,
        textbook: Textbook,
        size: int,
        status: str = "completed",
        error: str | None = None,
        file_hash: str | None = None,
    ) -> None:
        book_dir = self.parsed_dir / textbook.textbook_id
        chapters_dir = book_dir / "chapters"
        if file_hash is None:
            meta_path = book_dir / "meta.json"
            if meta_path.exists():
                try:
                    file_hash = self._read_json(meta_path).get("file_hash")
                except json.JSONDecodeError:
                    file_hash = None
        if book_dir.exists():
            shutil.rmtree(book_dir)
        chapters_dir.mkdir(parents=True, exist_ok=True)

        metadata = textbook.model_dump(exclude={"chapters"})
        metadata["size"] = size
        metadata["status"] = status
        metadata["error"] = error
        metadata["file_hash"] = file_hash
        metadata["chapters"] = []

        for chapter in textbook.chapters:
            chapter_path = chapters_dir / f"{chapter.chapter_id}.txt"
            chapter_path.write_text(chapter.content, encoding="utf-8")
            chapter_meta = chapter.model_dump(exclude={"content"})
            chapter_meta["content_path"] = str(chapter_path.relative_to(book_dir)).replace("\\", "/")
            metadata["chapters"].append(chapter_meta)

        (book_dir / "meta.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def save_failed(
        self,
        textbook_id: str,
        filename: str,
        file_format: str,
        size: int,
        error: str,
        file_hash: str | None = None,
    ) -> None:
        book_dir = self.parsed_dir / textbook_id
        book_dir.mkdir(parents=True, exist_ok=True)
        metadata = {
            "textbook_id": textbook_id,
            "filename": filename,
            "title": Path(filename).stem,
            "format": file_format,
            "size": size,
            "total_pages": None,
            "total_chars": 0,
            "status": "failed",
            "error": error,
            "file_hash": file_hash,
            "chapters": [],
        }
        (book_dir / "meta.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    def find_by_hash(self, file_hash: str) -> str | None:
        for meta_path in sorted(self.parsed_dir.glob("*/meta.json"), key=lambda item: item.stat().st_mtime):
            try:
                metadata = self._read_json(meta_path)
            except json.JSONDecodeError:
                continue
            if metadata.get("file_hash") == file_hash:
                return metadata.get("textbook_id")
        return None

    def list_summaries(self) -> list[TextbookSummary]:
        summaries = []
        for meta_path in sorted(self.parsed_dir.glob("*/meta.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                summaries.append(self._summary_from_meta(self._read_json(meta_path)))
            except json.JSONDecodeError:
                continue
        return summaries

    def get_summary(self, textbook_id: str) -> TextbookSummary | None:
        meta_path = self.parsed_dir / textbook_id / "meta.json"
        if not meta_path.exists():
            return None
        return self._summary_from_meta(self._read_json(meta_path))

    def get_textbook(self, textbook_id: str, include_content: bool = True) -> Textbook | None:
        book_dir = self.parsed_dir / textbook_id
        meta_path = book_dir / "meta.json"
        if not meta_path.exists():
            return None
        metadata = self._read_json(meta_path)
        chapters = []
        for chapter_meta in metadata.get("chapters", []):
            chapter_data = dict(chapter_meta)
            content_path = chapter_data.pop("content_path", None)
            if include_content and content_path:
                chapter_data["content"] = (book_dir / content_path).read_text(encoding="utf-8", errors="ignore")
            else:
                chapter_data["content"] = ""
            chapters.append(Chapter(**chapter_data))

        return Textbook(
            textbook_id=metadata["textbook_id"],
            filename=metadata["filename"],
            title=metadata["title"],
            format=metadata["format"],
            total_pages=metadata.get("total_pages"),
            total_chars=metadata.get("total_chars", 0),
            chapters=chapters,
        )

    def save_knowledge_graph(self, graph: KnowledgeGraph) -> None:
        book_dir = self.parsed_dir / graph.textbook_id
        if not book_dir.exists():
            raise FileNotFoundError(f"Textbook does not exist: {graph.textbook_id}")
        (book_dir / "knowledge_graph.json").write_text(
            json.dumps(graph.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def get_knowledge_graph(self, textbook_id: str) -> KnowledgeGraph | None:
        graph_path = self.parsed_dir / textbook_id / "knowledge_graph.json"
        if not graph_path.exists():
            return None
        return KnowledgeGraph(**self._read_json(graph_path))

    def list_knowledge_graphs(self) -> list[KnowledgeGraph]:
        graphs = []
        for meta in self.list_summaries():
            graph = self.get_knowledge_graph(meta.textbook_id)
            if graph:
                graphs.append(graph)
        return graphs

    def delete_textbook(self, textbook_id: str) -> bool:
        removed = False
        for directory in (self.parsed_dir / textbook_id, self.uploads_dir / textbook_id):
            if directory.exists():
                shutil.rmtree(directory)
                removed = True
        return removed

    @staticmethod
    def _read_json(path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _summary_from_meta(metadata: dict) -> TextbookSummary:
        return TextbookSummary(
            textbook_id=metadata["textbook_id"],
            filename=metadata["filename"],
            title=metadata["title"],
            format=metadata["format"],
            size=metadata.get("size", 0),
            total_pages=metadata.get("total_pages"),
            total_chars=metadata.get("total_chars", 0),
            chapter_count=len(metadata.get("chapters", [])),
            status=metadata.get("status", "completed"),
            error=metadata.get("error"),
        )
