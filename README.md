# 学科知识整合智能体

面向“第一届 AI 全栈黑客松”赛题的教材解析、知识整合与问答系统。项目目标不是针对固定七本教材写死规则，而是实现一个可复用的通用智能体：上传任意 PDF、Markdown、TXT、DOCX 教材后，系统自动解析正文、识别章节结构、生成统一 JSON、抽取知识图谱，并支持基于教材原文的 RAG 问答。

## 核心能力

- 多格式教材加载：支持 PDF、Markdown、TXT、DOCX 批量上传。
- 通用解析输出：导出赛题要求的 `textbook_id / filename / title / total_pages / total_chars / chapters` 结构。
- 真实书名识别：优先从 PDF 元数据和标题页提取书名，文件名仅作为兜底。
- 章节结构识别：识别中英文章标题，过滤目录、页眉页脚、数字资源提示、索引等非正文噪声。
- 重复上传治理：基于 SHA-256 指纹去重，重复文件不会生成重复教材记录。
- 知识图谱生成：调用 ModelScope 兼容接口抽取知识点与关系，支持单本和多本聚合视图。
- RAG 教材问答：将章节切分为可检索片段，基于向量召回和大模型生成带来源的答案。
- Web 交互界面：提供上传、教材管理、图谱交互、RAG 问答和 JSON 导出。

## 技术栈

- Python 3.10+
- FastAPI + Uvicorn
- pypdf / python-docx
- ModelScope OpenAI-compatible API
- sentence-transformers + NumPy
- 原生 HTML / CSS / JavaScript

## 本地运行

```bash
pip install -r requirements.txt
cp .env.example .env
uvicorn src.app.main:app --reload --host 0.0.0.0 --port 8000
```

Windows PowerShell 可使用：

```powershell
Copy-Item .env.example .env
uvicorn src.app.main:app --reload --host 0.0.0.0 --port 8000
```

访问：

```text
http://localhost:8000
```

## 环境变量

`.env` 不应提交到 GitHub。请从 `.env.example` 复制后填写：

```env
MODELSCOPE_API_KEY=your_modelscope_api_key_here
MODELSCOPE_API_BASE=https://api-inference.modelscope.cn/v1
MODELSCOPE_MODEL=Qwen/Qwen3-30B-A3B-Instruct-2507
MODELSCOPE_TIMEOUT_SECONDS=120
MODELSCOPE_MAX_RETRIES=2
KG_CHUNK_CHARS=8000
KG_CHAPTER_CONCURRENCY=1
KG_CHUNK_CONCURRENCY=2
RAG_CHUNK_SIZE=600
RAG_CHUNK_OVERLAP=120
RAG_TOP_K=5
RAG_EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5
```

不配置 `MODELSCOPE_API_KEY` 时，教材上传和解析仍可使用；知识图谱生成与 RAG 生成回答会提示缺少模型配置。

## 在线部署

仓库已提供 `Dockerfile`、`.dockerignore` 和 `render.yaml`，可直接部署到 Render、Railway、Fly.io 等支持 Docker 或 Python Web Service 的平台。

Render 部署步骤：

1. 在 Render 新建 Web Service，连接本 GitHub 仓库。
2. 选择 Python 或 Docker 环境。
3. 设置启动命令：

```bash
uvicorn src.app.main:app --host 0.0.0.0 --port $PORT
```

4. 在平台环境变量中配置 `MODELSCOPE_API_KEY` 等参数。
5. 部署完成后访问平台生成的公网 URL。

说明：教材原文、解析缓存、向量索引和 `.env` 均被 `.gitignore` / `.dockerignore` 排除，不会上传到 GitHub 或构建镜像。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/textbooks/upload` | 批量上传并解析教材 |
| `GET` | `/api/textbooks` | 获取教材列表 |
| `GET` | `/api/textbooks/{textbook_id}` | 获取教材结构，可用 `include_content=true` 返回正文 |
| `GET` | `/api/textbooks/{textbook_id}/export` | 导出统一 JSON |
| `DELETE` | `/api/textbooks/{textbook_id}` | 删除教材及缓存 |
| `POST` | `/api/textbooks/{textbook_id}/knowledge-graph` | 同步生成单本知识图谱 |
| `POST` | `/api/textbooks/{textbook_id}/knowledge-graph/jobs` | 异步生成单本知识图谱 |
| `GET` | `/api/knowledge-graph` | 获取多本聚合知识图谱 |
| `POST` | `/api/rag/index/{textbook_id}` | 为单本教材建立 RAG 索引 |
| `POST` | `/api/rag/index-all` | 为全部教材建立 RAG 索引 |
| `POST` | `/api/rag/query` | 基于教材原文问答 |

## 统一 JSON 示例

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

## 目录结构

```text
src/
  app/
    main.py              # FastAPI 入口与 API
    parser.py            # 多格式教材解析
    storage.py           # 文件与解析结果存储
    graph_builder.py     # 知识图谱抽取与合并
    rag_engine.py        # RAG 问答编排
    chunker.py           # 教材分块
    vector_store.py      # 向量索引
    modelscope_client.py # 大模型客户端
    schemas.py           # 数据结构
  web/
    index.html
    app.js
    styles.css
docs/
  需求分析.md
  系统设计.md
  Agent 架构说明.md
  接口文档.md
report/
  整合报告.md
```

本地运行产生的 `data/`、教材 PDF、`.env`、缓存文件均不会提交。
