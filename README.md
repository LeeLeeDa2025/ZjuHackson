# ZjuHackson

学科知识整合智能体。当前实现了多格式教材加载解析、章节结构识别、教材去重管理、单本/聚合知识图谱生成与可视化。

## 已实现功能

- Web 上传界面：支持拖拽上传和批量选择文件。
- 文件格式：PDF、Markdown、TXT、DOCX。
- 解析状态：上传后展示文件名、真实书名、格式、大小、章节数、字数和解析状态。
- PDF 解析：逐页提取文本，按 `第 X 章` / `Chapter N` 等标题识别章节。
- 章节清洗：过滤封面、目录、页眉页脚、数字资源提示、索引等非正文内容。
- 书名推断：优先从 PDF 元数据和标题页内容提取真实教材名，文件名仅作为兜底。
- 重复上传处理：基于 SHA-256 文件指纹去重，同一教材重复上传不会生成重复记录。
- 教材管理：支持删除已上传教材及其解析缓存。
- 统一输出结构：`/api/textbooks/{id}/export` 返回赛题要求的完整 JSON。
- 知识图谱：基于 ModelScope 兼容接口抽取知识点和关系，并在前端可视化展示。
- 大文件友好存储：章节正文拆分保存，避免长期维护单体大 JSON。

## 环境要求

- Python 3.10+

## 安装

```bash
pip install -r requirements.txt
```

## 配置

复制 `.env.example` 为 `.env`，并按需填写 ModelScope API Key：

```bash
cp .env.example .env
```

```env
MODELSCOPE_API_KEY=your_modelscope_api_key_here
MODELSCOPE_API_BASE=https://api-inference.modelscope.cn/v1
MODELSCOPE_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507
MODELSCOPE_TIMEOUT_SECONDS=120
KG_MAX_CHARS_PER_CHAPTER=12000
```

不配置 Key 时，教材上传与解析仍可使用；知识图谱生成会提示未配置模型。

## 启动

```bash
uvicorn src.app.main:app --reload --host 0.0.0.0 --port 8000
```

打开浏览器访问：

```text
http://localhost:8000
```

## API

### 上传并解析教材

```http
POST /api/textbooks/upload
```

表单字段：`files`，支持多个文件。

### 获取教材列表

```http
GET /api/textbooks
```

### 获取教材结构

```http
GET /api/textbooks/{textbook_id}
```

默认不返回章节全文，适合前端章节结构展示。

### 导出统一 JSON

```http
GET /api/textbooks/{textbook_id}/export
```

返回结构示例：

```json
{
  "textbook_id": "book_01",
  "filename": "生理学.pdf",
  "title": "生理学",
  "format": "pdf",
  "total_pages": 520,
  "total_chars": 385000,
  "chapters": [
    {
      "chapter_id": "ch_001",
      "title": "第一章 绪论",
      "page_start": 1,
      "page_end": 15,
      "content": "生理学是研究生物体正常生命活动规律的科学...",
      "char_count": 8500
    }
  ]
}
```

### 删除教材

```http
DELETE /api/textbooks/{textbook_id}
```

### 生成单本教材知识图谱

```http
POST /api/textbooks/{textbook_id}/knowledge-graph
```

### 获取聚合知识图谱

```http
GET /api/knowledge-graph
```

## 数据目录

上传和解析结果默认保存在 `data/` 下：

```text
data/
  uploads/
  parsed/
    book_xxx/
      meta.json
      chapters/
        ch_001.txt
```

`data/`、`.env` 和教材 PDF 不会提交到 GitHub。
