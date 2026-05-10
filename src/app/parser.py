from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from docx import Document
from pypdf import PdfReader

from .schemas import Chapter, Textbook


CHAPTER_PATTERNS = [
    re.compile(r"^\s*(第[一二三四五六七八九十百千万\d]+章\s*[^\n]{0,80})\s*$"),
    re.compile(r"^\s*(Chapter\s+\d+[\w\s:：.-]{0,80})\s*$", re.IGNORECASE),
]

HEADING_MD_RE = re.compile(r"^(#{1,3})\s+(.+?)\s*$")
STANDALONE_HEADINGS = {"绪论", "导论", "前言", "推荐阅读", "参考文献", "中英文名词对照索引"}
STOP_HEADINGS = {"推荐阅读", "参考文献", "中英文名词对照索引"}
DIGITAL_RESOURCE_PATTERNS = [
    re.compile(r"^本章数字资源$"),
    re.compile(r"^数字资源$"),
    re.compile(r"^【?数字特色[:：].*】?$"),
    re.compile(r"^AR\s*模型\s*\d*", re.IGNORECASE),
    re.compile(r".*(扫码|扫描).*(二维码|查看|获取).*"),
    re.compile(r".*(人卫APP|人卫\s*e\s*教|电子教材|在线课程|获取海量医学学习资源).*", re.IGNORECASE),
    re.compile(r".*(视频|动画|虚拟仿真|数字切片|DICOM).*(资源|查看|扫码|扫描).*"),
]


@dataclass
class PageText:
    page_number: int
    text: str


class UnsupportedFormatError(ValueError):
    pass


def parse_textbook(path: Path, textbook_id: str, original_filename: str | None = None) -> Textbook:
    suffix = path.suffix.lower()
    filename = original_filename or path.name
    fallback_title = _title_from_filename(filename)

    if suffix == ".pdf":
        return _parse_pdf(path, textbook_id, filename, fallback_title)
    if suffix in {".md", ".markdown"}:
        text = path.read_text(encoding="utf-8", errors="ignore")
        title = _infer_title_from_text(text, fallback_title, prefer_markdown=True)
        return _parse_text_document(text, textbook_id, filename, title, "markdown")
    if suffix == ".txt":
        text = path.read_text(encoding="utf-8", errors="ignore")
        title = _infer_title_from_text(text, fallback_title)
        return _parse_text_document(text, textbook_id, filename, title, "txt")
    if suffix == ".docx":
        return _parse_docx(path, textbook_id, filename, fallback_title)

    raise UnsupportedFormatError(f"Unsupported file format: {suffix or 'unknown'}")


def _parse_pdf(path: Path, textbook_id: str, filename: str, fallback_title: str) -> Textbook:
    reader = PdfReader(str(path))
    pages: list[PageText] = []
    for index, page in enumerate(reader.pages, start=1):
        raw = page.extract_text() or ""
        cleaned = _clean_page_text(raw, index)
        if cleaned:
            pages.append(PageText(page_number=index, text=cleaned))

    metadata_title = _clean_pdf_metadata_title(getattr(reader.metadata, "title", None))
    title = metadata_title or _infer_title_from_pages(pages, fallback_title)
    body_pages = _drop_front_matter_pages(pages)
    chapters = _split_pages_into_chapters(body_pages)
    total_chars = sum(ch.char_count for ch in chapters)
    return Textbook(
        textbook_id=textbook_id,
        filename=filename,
        title=title,
        format="pdf",
        total_pages=len(reader.pages),
        total_chars=total_chars,
        chapters=chapters,
    )


def _parse_text_document(
    text: str,
    textbook_id: str,
    filename: str,
    title: str,
    file_format: str,
) -> Textbook:
    cleaned = _normalize_text(text)
    chapters = _split_markdown(cleaned) if file_format == "markdown" else _split_plain_text(cleaned)
    total_chars = sum(ch.char_count for ch in chapters)
    return Textbook(
        textbook_id=textbook_id,
        filename=filename,
        title=title,
        format=file_format,
        total_pages=None,
        total_chars=total_chars,
        chapters=chapters,
    )


def _parse_docx(path: Path, textbook_id: str, filename: str, fallback_title: str) -> Textbook:
    document = Document(str(path))
    lines = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    text = "\n".join(lines)
    title = _infer_title_from_text(text, fallback_title)
    chapters = _split_plain_text(_normalize_text(text))
    total_chars = sum(ch.char_count for ch in chapters)
    return Textbook(
        textbook_id=textbook_id,
        filename=filename,
        title=title,
        format="docx",
        total_pages=None,
        total_chars=total_chars,
        chapters=chapters,
    )


def _split_pages_into_chapters(pages: list[PageText]) -> list[Chapter]:
    chapters: list[Chapter] = []
    current_title = _infer_initial_chapter_title(pages)
    current_start = pages[0].page_number if pages else None
    current_lines: list[str] = []
    chapter_index = 1
    last_page = current_start

    for page in pages:
        lines = page.text.splitlines()
        for line in lines:
            heading = _match_chapter_heading(line)
            if heading and _is_same_chapter_heading(heading, current_title):
                current_title = _prefer_richer_heading(current_title, heading)
                continue
            if heading in STOP_HEADINGS:
                if current_lines:
                    chapters.append(
                        _make_chapter(chapter_index, current_title, current_start, last_page, "\n".join(current_lines))
                    )
                return _discard_empty_chapters(chapters) or [_make_chapter(1, "全文", None, None, "")]
            if heading and current_lines:
                chapters.append(
                    _make_chapter(chapter_index, current_title, current_start, last_page, "\n".join(current_lines))
                )
                chapter_index += 1
                current_title = heading
                current_start = page.page_number
                current_lines = []
            elif heading and not current_lines and current_title in {"全文", "正文"}:
                current_title = heading
                current_start = page.page_number
            else:
                current_lines.append(line)
        last_page = page.page_number

    if current_lines:
        chapters.append(_make_chapter(chapter_index, current_title, current_start, last_page, "\n".join(current_lines)))

    chapters = _discard_empty_chapters(chapters)
    return chapters or [_make_chapter(1, "全文", None, None, "")]


def _split_markdown(text: str) -> list[Chapter]:
    chapters: list[Chapter] = []
    current_title = "全文"
    current_lines: list[str] = []
    chapter_index = 1

    for line in text.splitlines():
        match = HEADING_MD_RE.match(line)
        if match and current_lines:
            chapters.append(_make_chapter(chapter_index, current_title, None, None, "\n".join(current_lines)))
            chapter_index += 1
            current_title = match.group(2).strip()
            current_lines = [line]
        elif match and not current_lines and current_title == "全文":
            current_title = match.group(2).strip()
            current_lines.append(line)
        else:
            current_lines.append(line)

    if current_lines:
        chapters.append(_make_chapter(chapter_index, current_title, None, None, "\n".join(current_lines)))

    return chapters or [_make_chapter(1, "全文", None, None, text)]


def _split_plain_text(text: str) -> list[Chapter]:
    pseudo_pages = [PageText(page_number=1, text=text)]
    chapters = _split_pages_into_chapters(pseudo_pages)
    if len(chapters) == 1 and chapters[0].title == "全文" and chapters[0].char_count > 20_000:
        return _split_large_plain_text(chapters[0].content)
    return chapters


def _split_large_plain_text(text: str, target_chars: int = 12_000) -> list[Chapter]:
    chapters: list[Chapter] = []
    for index, start in enumerate(range(0, len(text), target_chars), start=1):
        segment = text[start : start + target_chars]
        chapters.append(_make_chapter(index, f"文本片段 {index}", None, None, segment))
    return chapters


def _make_chapter(
    index: int,
    title: str,
    page_start: int | None,
    page_end: int | None,
    content: str,
) -> Chapter:
    normalized = _normalize_text(content)
    return Chapter(
        chapter_id=f"ch_{index:03d}",
        title=title.strip() or f"章节 {index}",
        page_start=page_start,
        page_end=page_end,
        content=normalized,
        char_count=len(normalized),
    )


def _match_chapter_heading(line: str) -> str | None:
    compact = line.strip()
    if len(compact) > 60:
        return None
    if _looks_like_toc_line(compact):
        return None
    if _looks_like_inline_chapter_reference(compact):
        return None
    if compact in STANDALONE_HEADINGS:
        return compact
    for pattern in CHAPTER_PATTERNS:
        match = pattern.match(compact)
        if match:
            heading = _clean_heading_text(match.group(1))
            if _is_bad_chapter_heading(heading):
                return None
            return heading
    return None


def _clean_page_text(text: str, page_number: int) -> str:
    lines = []
    raw_lines = text.splitlines()
    last_index = len(raw_lines) - 1
    for index, raw_line in enumerate(raw_lines):
        line = _strip_control_chars(raw_line).strip()
        if not line:
            continue
        if _looks_like_artifact_line(line):
            continue
        if _looks_like_digital_resource_line(line):
            continue
        if line == str(page_number) or line == f"第 {page_number} 页":
            continue
        if re.fullmatch(r"\d{1,4}", line) and (index <= 2 or index >= last_index - 2):
            continue
        if re.fullmatch(r"第\s*\d+\s*页\s*/\s*共\s*\d+\s*页", line):
            continue
        lines.append(line)
    return _normalize_text("\n".join(lines))


def _normalize_text(text: str) -> str:
    text = _strip_control_chars(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _drop_front_matter_pages(pages: list[PageText]) -> list[PageText]:
    if not pages:
        return pages

    last_toc_index = -1
    for index, page in enumerate(pages[:80]):
        if _is_table_of_contents_page(page.text):
            last_toc_index = index

    if last_toc_index >= 0 and last_toc_index + 1 < len(pages):
        return pages[last_toc_index + 1 :]

    first_heading_index = 0
    for index, page in enumerate(pages[:80]):
        if any(_match_chapter_heading(line) for line in page.text.splitlines()):
            first_heading_index = index
            break
    return pages[first_heading_index:]


def _is_table_of_contents_page(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if any(line == "目录" for line in lines[:8]):
        return True

    toc_markers = 0
    for line in lines:
        if "..." in line or "……" in line or re.search(r"\.{3,}\s*\d+\s*$", line):
            toc_markers += 1
        elif re.search(r"第[一二三四五六七八九十百千万\d]+[章节]\s+.{1,40}\s+\d+\s*$", line):
            toc_markers += 1

    return toc_markers >= 5


def _infer_initial_chapter_title(pages: list[PageText]) -> str:
    for page in pages[:3]:
        for line in page.text.splitlines():
            heading = _match_chapter_heading(line)
            if heading:
                return heading
    return "正文"


def _heading_key(title: str) -> str:
    return re.sub(r"[\s\u2000-\u200f\u3000|｜·.,，。:：-]+", "", title)


def _chapter_ordinal(title: str) -> str | None:
    match = re.match(r"^\s*第([一二三四五六七八九十百千万\d]+)章", title)
    return match.group(1) if match else None


def _is_same_chapter_heading(left: str, right: str) -> bool:
    if _heading_key(left) == _heading_key(right):
        return True
    left_ordinal = _chapter_ordinal(left)
    right_ordinal = _chapter_ordinal(right)
    return bool(left_ordinal and left_ordinal == right_ordinal)


def _prefer_richer_heading(current_title: str, candidate: str) -> str:
    return candidate if len(_heading_key(candidate)) > len(_heading_key(current_title)) else current_title


def _clean_heading_text(title: str) -> str:
    title = re.sub(r"[\u2000-\u200f\u3000]+", " ", title)
    title = re.sub(r"\s+", " ", title).strip()
    return title


def _discard_empty_chapters(chapters: list[Chapter]) -> list[Chapter]:
    if len(chapters) <= 1:
        return chapters
    return [chapter for chapter in chapters if chapter.char_count >= 50]


def _looks_like_toc_line(line: str) -> bool:
    if "..." in line or "……" in line:
        return True
    return bool(re.search(r"第[一二三四五六七八九十百千万\d]+[章节]\s+.{1,40}\s+\d+\s*$", line))


def _looks_like_inline_chapter_reference(line: str) -> bool:
    return bool(re.match(r"^\s*第[一二三四五六七八九十百千万\d]+章\s*[）).,，。；;、]", line))


def _is_bad_chapter_heading(heading: str) -> bool:
    rest = re.sub(r"^\s*第[一二三四五六七八九十百千万\d]+章\s*", "", heading).strip()
    if not rest:
        return False
    if len(_heading_key(rest)) > 24:
        return True
    bad_punctuation = "，,。；;：:（）()[]【】"
    if any(char in rest for char in bad_punctuation):
        return True
    return False


def _looks_like_artifact_line(line: str) -> bool:
    if "JOEE" in line or "QEG" in line:
        return True
    if len(line) >= 8:
        non_text = sum(1 for char in line if ord(char) < 32 or "\u0e00" <= char <= "\u0eff")
        return non_text / len(line) > 0.25
    return False


def _looks_like_digital_resource_line(line: str) -> bool:
    compact = re.sub(r"\s+", "", line)
    return any(pattern.match(compact) or pattern.match(line) for pattern in DIGITAL_RESOURCE_PATTERNS)


def _strip_control_chars(text: str) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)


def _title_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"^[\d\s._-]+", "", stem)
    stem = re.sub(r"[_-]+", " ", stem).strip()
    return stem or Path(filename).stem


def _clean_pdf_metadata_title(title: str | None) -> str | None:
    if not title:
        return None
    cleaned = _clean_title_candidate(title)
    if _is_bad_title_candidate(cleaned):
        return None
    return cleaned


def _infer_title_from_pages(pages: list[PageText], fallback_title: str) -> str:
    candidates: dict[str, dict[str, int]] = {}
    for page_index, page in enumerate(pages[:8], start=1):
        for raw_line in page.text.splitlines():
            candidate = _clean_title_candidate(raw_line)
            if _is_bad_title_candidate(candidate):
                continue
            item = candidates.setdefault(candidate, {"count": 0, "first_page": page_index})
            item["count"] += 1
            item["first_page"] = min(item["first_page"], page_index)

    if not candidates:
        return fallback_title

    fallback_key = _heading_key(fallback_title)

    def score(item: tuple[str, dict[str, int]]) -> tuple[int, int, int]:
        candidate, stats = item
        compact = _heading_key(candidate)
        value = stats["count"] * 8
        value += max(0, 8 - stats["first_page"])
        value += 8 if _contains_cjk(candidate) else 0
        value += 5 if 2 <= len(compact) <= 12 else 0
        value += 3 if compact and compact in fallback_key else 0
        value += 2 if candidate.endswith(("学", "论", "法", "学概论", "教程", "原理")) else 0
        value -= 4 if len(compact) > 20 else 0
        return (value, stats["count"], -len(compact))

    return max(candidates.items(), key=score)[0]


def _infer_title_from_text(text: str, fallback_title: str, prefer_markdown: bool = False) -> str:
    lines = [_clean_title_candidate(line) for line in text.splitlines()[:80]]
    if prefer_markdown:
        for line in lines:
            match = HEADING_MD_RE.match(line)
            if match:
                candidate = _clean_title_candidate(match.group(2))
                if not _is_bad_title_candidate(candidate):
                    return candidate

    for line in lines:
        if not _is_bad_title_candidate(line):
            return line
    return fallback_title


def _clean_title_candidate(text: str) -> str:
    text = _strip_control_chars(text)
    text = re.sub(r"[\u2000-\u200f\u3000]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" \t\r\n·—-_|｜:：")


def _is_bad_title_candidate(candidate: str) -> bool:
    if not candidate:
        return True
    compact = _heading_key(candidate)
    if len(compact) < 2 or len(compact) > 36:
        return True
    if re.fullmatch(r"\d+", compact):
        return True
    if re.fullmatch(r"第?\d+版", compact) or re.fullmatch(r"第[一二三四五六七八九十百千万\d]+版", compact):
        return True
    if candidate in {"目录", "序言", "前言", "编委名单", "主编简介", "新形态教材使用说明"}:
        return True
    noisy_keywords = [
        "ISBN",
        "CIP",
        "www",
        "http",
        "E-mail",
        "定价",
        "版权所有",
        "出版",
        "发行",
        "印刷",
        "经销",
        "地址",
        "邮编",
        "购书",
        "热线",
        "主编",
        "副主编",
        "编委",
        "责任编辑",
        "策划编辑",
        "数字编辑",
        "国家卫生健康委员会",
        "全国高等学校",
        "供基础",
        "人卫",
        "扫码",
        "扫描",
        "二维码",
    ]
    if any(keyword.lower() in candidate.lower() for keyword in noisy_keywords):
        return True
    digits = sum(char.isdigit() for char in candidate)
    if digits and digits / max(len(candidate), 1) > 0.35:
        return True
    return not (_contains_cjk(candidate) or re.search(r"[A-Za-z]{3,}", candidate))


def _contains_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text)
