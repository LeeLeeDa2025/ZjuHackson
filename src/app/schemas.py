from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


ParseStatus = Literal["parsing", "completed", "failed"]
RelationType = Literal["prerequisite", "parallel", "contains", "applies_to"]


class Chapter(BaseModel):
    chapter_id: str
    title: str
    page_start: int | None = None
    page_end: int | None = None
    content: str = ""
    char_count: int = 0


class Textbook(BaseModel):
    textbook_id: str
    filename: str
    title: str
    format: str
    total_pages: int | None = None
    total_chars: int = 0
    chapters: list[Chapter] = Field(default_factory=list)


class TextbookSummary(BaseModel):
    textbook_id: str
    filename: str
    title: str
    format: str
    size: int
    total_pages: int | None = None
    total_chars: int = 0
    chapter_count: int = 0
    status: ParseStatus
    error: str | None = None


class UploadResult(BaseModel):
    files: list[TextbookSummary]


class KnowledgeNode(BaseModel):
    id: str
    name: str
    definition: str
    category: str
    chapter: str
    page: int | None = None
    source_excerpt: str | None = None


class KnowledgeEdge(BaseModel):
    source: str
    target: str
    relation_type: RelationType
    description: str


class KnowledgeGraph(BaseModel):
    textbook_id: str
    title: str
    model: str
    generated_at: str
    chapter_count: int
    nodes: list[KnowledgeNode] = Field(default_factory=list)
    edges: list[KnowledgeEdge] = Field(default_factory=list)


class KnowledgeGraphBuildRequest(BaseModel):
    chapter_ids: list[str] | None = None
    max_chapters: int = Field(default=3, ge=1, le=20)
    force: bool = False
