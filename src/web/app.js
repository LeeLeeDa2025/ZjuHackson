const SOURCE_COLORS = ["#12715d", "#3267a8", "#b76e00", "#7b6ab5", "#b42318", "#4f7f2a", "#a1447a"];
const RELATION_ORDER = ["prerequisite", "parallel", "contains", "applies_to"];
const RELATION_LABELS = {
  prerequisite: "前置依赖",
  parallel: "并列关系",
  contains: "包含关系",
  applies_to: "应用关系",
};
const CATEGORY_SHAPES = [
  { key: "disease", label: "疾病/病理", shape: "diamond", keywords: ["疾病", "病", "感染", "炎症", "综合征"] },
  { key: "structure", label: "结构/组织", shape: "square", keywords: ["结构", "组织", "器官", "细胞", "解剖"] },
  { key: "mechanism", label: "机制/过程", shape: "triangle", keywords: ["机制", "过程", "功能", "调控", "代谢", "反应"] },
  { key: "method", label: "方法/检查", shape: "hexagon", keywords: ["检查", "诊断", "治疗", "方法", "实验", "技术"] },
];
const GRAPH_NODE_LIMIT = 280;
const GRAPH_MIN_SCALE = 0.35;
const GRAPH_MAX_SCALE = 8;
const GRAPH_WHEEL_ZOOM_SPEED = 0.0025;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

const state = {
  textbooks: [],
  activeBook: null,
  activeChapterId: null,
  graph: null,
  graphMergeMode: "merged",
  graphPositions: new Map(),
  graphLayoutKey: "",
  selectedNodeId: null,
  searchQuery: "",
  graphView: "graph",
  relationFilter: new Set(RELATION_ORDER),
  view: { scale: 1, x: 0, y: 0 },
  pointer: null,
  suppressGraphClick: false,
  uploadItems: [],
  buildSteps: [],
  ragHistory: [],
};

const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const fileList = document.querySelector("#fileList");
const bookCount = document.querySelector("#bookCount");
const chapterCount = document.querySelector("#chapterCount");
const charCount = document.querySelector("#charCount");
const activeTitle = document.querySelector("#activeTitle");
const parseStatus = document.querySelector("#parseStatus");
const chapterList = document.querySelector("#chapterList");
const exportButton = document.querySelector("#exportButton");
const graphButton = document.querySelector("#graphButton");
const graphScopeSelect = document.querySelector("#graphScopeSelect");
const graphStatus = document.querySelector("#graphStatus");
const graphSvg = document.querySelector("#graphSvg");
const graphMatrix = document.querySelector("#graphMatrix");
const graphStats = document.querySelector("#graphStats");
const graphSearch = document.querySelector("#graphSearch");
const graphMergeModeSelect = document.querySelector("#graphMergeModeSelect");
const graphLegend = document.querySelector("#graphLegend");
const resetViewButton = document.querySelector("#resetViewButton");
const graphViewButtons = document.querySelectorAll("[data-graph-view]");
const relationFilterInputs = document.querySelectorAll("[data-relation-filter]");
const nodeDetail = document.querySelector("#nodeDetail");
const detailFrequency = document.querySelector("#detailFrequency");
const modelscopeStatus = document.querySelector("#modelscopeStatus");
const uploadProgressPanel = document.querySelector("#uploadProgressPanel");
const uploadProgressList = document.querySelector("#uploadProgressList");
const uploadProgressSummary = document.querySelector("#uploadProgressSummary");
const buildProgressSteps = document.querySelector("#buildProgressSteps");
const buildProgressPercent = document.querySelector("#buildProgressPercent");

fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
exportButton.addEventListener("click", exportActiveBook);
graphButton.addEventListener("click", buildKnowledgeGraphByScope);
graphScopeSelect.addEventListener("change", () => {
  if (graphScopeSelect.value !== "all") selectBook(graphScopeSelect.value);
  else loadAggregateGraph();
});
graphMergeModeSelect.addEventListener("change", () => {
  state.graphMergeMode = graphMergeModeSelect.value;
  loadAggregateGraph();
});
graphSearch.addEventListener("input", () => {
  state.searchQuery = graphSearch.value.trim().toLowerCase();
  renderKnowledgeGraph();
});
resetViewButton.addEventListener("click", () => {
  state.view = { scale: 1, x: 0, y: 0 };
  renderKnowledgeGraph();
});
graphViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.graphView = button.dataset.graphView || "graph";
    renderKnowledgeGraph();
  });
});
relationFilterInputs.forEach((input) => {
  input.addEventListener("change", () => {
    state.relationFilter = new Set(
      Array.from(relationFilterInputs)
        .filter((item) => item.checked)
        .map((item) => item.value),
    );
    renderKnowledgeGraph();
  });
});

graphSvg.addEventListener("wheel", onGraphWheel, { passive: false });
graphSvg.addEventListener("click", onGraphClick);
graphSvg.addEventListener("pointerdown", onGraphPointerDown);
graphSvg.addEventListener("pointermove", onGraphPointerMove);
graphSvg.addEventListener("pointerup", endGraphPointer);
graphSvg.addEventListener("pointerleave", endGraphPointer);

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
});

dropZone.addEventListener("drop", (event) => uploadFiles(event.dataTransfer.files));

async function boot() {
  resetPreview();
  renderBuildProgress(defaultBuildSteps());
  await Promise.all([loadModelScopeConfig(), loadTextbooks(), loadRagStatus()]);
}

async function loadModelScopeConfig() {
  const response = await fetch("/api/config/modelscope");
  const config = await response.json();
  modelscopeStatus.textContent = config.configured ? `魔搭已配置 · ${config.model}` : "魔搭未配置 · 请设置 MODELSCOPE_API_KEY";
  modelscopeStatus.className = `status-pill ${config.configured ? "" : "failed"}`;
}

async function loadTextbooks() {
  const response = await fetch("/api/textbooks");
  state.textbooks = await response.json();
  if (!state.activeBook && state.textbooks.length) {
    const firstCompleted = state.textbooks.find((book) => book.status === "completed") || state.textbooks[0];
    state.activeBook = { ...firstCompleted, chapters: [] };
  }
  renderTextbookList();
  renderGraphScopeOptions();
  renderStats();
  graphButton.disabled = !state.textbooks.length;
  await loadAggregateGraph();
}

async function loadAggregateGraph() {
  const merged = state.graphMergeMode !== "source";
  const response = await fetch(`/api/knowledge-graph?merged=${merged ? "true" : "false"}`);
  if (!response.ok) return loadActiveGraphFallback();
  state.graph = await response.json();
  ensureGraphPositions();
  renderKnowledgeGraph();
  return true;
}

async function loadActiveGraphFallback() {
  if (!state.activeBook?.textbook_id) return false;
  const response = await fetch(`/api/textbooks/${encodeURIComponent(state.activeBook.textbook_id)}/knowledge-graph`);
  if (!response.ok) return false;
  state.graph = graphToAggregate(await response.json());
  ensureGraphPositions();
  renderKnowledgeGraph();
  return true;
}

async function uploadFiles(fileListData) {
  const files = Array.from(fileListData || []);
  if (!files.length) return;

  state.uploadItems = files.map((file) => ({
    name: file.name,
    size: file.size,
    progress: 0,
    status: file.size > MAX_UPLOAD_BYTES ? "skipped" : "queued",
    error: file.size > MAX_UPLOAD_BYTES ? `超过 ${formatSize(MAX_UPLOAD_BYTES)}，请压缩或拆分后再上传` : "",
  }));
  renderUploadProgress();

  const uploadableFiles = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
  if (!uploadableFiles.length) {
    alert(`单个文件不能超过 ${formatSize(MAX_UPLOAD_BYTES)}。Render 免费实例不适合直接上传超大 PDF。`);
    fileInput.value = "";
    return;
  }

  setUploading(true);

  let failedCount = state.uploadItems.filter((item) => item.status === "skipped").length;
  try {
    for (const file of uploadableFiles) {
      markUploadItem(file, { status: "uploading", progress: 0, error: "" });
      try {
        await uploadWithProgress(file, (progress) => {
          markUploadItem(file, { progress, status: progress >= 100 ? "processing" : "uploading" });
        });
        markUploadItem(file, { progress: 100, status: "completed", error: "" });
      } catch (error) {
        failedCount += 1;
        markUploadItem(file, { status: "failed", error: error.message || "上传失败" });
      }
    }
    await loadTextbooks();
    if (failedCount) alert("部分文件上传失败，请查看进度列表中的提示。");
  } finally {
    setUploading(false);
    fileInput.value = "";
  }
}

function uploadWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("files", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/textbooks/upload");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      onProgress(progress);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText || "{}"));
        return;
      }
      reject(new Error(readUploadError(xhr)));
    });
    xhr.addEventListener("error", () => reject(new Error("上传失败")));
    xhr.send(formData);
  });
}

function markUploadItem(file, patch) {
  state.uploadItems = state.uploadItems.map((item) =>
    item.name === file.name && item.size === file.size ? { ...item, ...patch } : item,
  );
  renderUploadProgress();
}

function readUploadError(xhr) {
  try {
    const data = JSON.parse(xhr.responseText || "{}");
    return data.detail || data.message || "上传失败";
  } catch {
    return xhr.responseText || "上传失败";
  }
}

function renderUploadProgress() {
  if (!state.uploadItems.length) {
    uploadProgressPanel.classList.add("hidden");
    uploadProgressSummary.textContent = "待上传";
    uploadProgressSummary.className = "status-pill muted";
    uploadProgressList.innerHTML = "";
    return;
  }

  uploadProgressPanel.classList.remove("hidden");
  const average = Math.round(state.uploadItems.reduce((sum, item) => sum + item.progress, 0) / state.uploadItems.length);
  const allDone = state.uploadItems.every((item) => item.status === "completed");
  const hasFailed = state.uploadItems.some((item) => item.status === "failed");
  const hasSkipped = state.uploadItems.some((item) => item.status === "skipped");
  uploadProgressSummary.textContent = hasFailed ? "部分失败" : hasSkipped ? "有文件过大" : allDone ? "100%" : `${average}%`;
  uploadProgressSummary.className = `status-pill ${hasFailed ? "failed" : allDone ? "" : "parsing"}`;
  uploadProgressList.innerHTML = state.uploadItems
    .map(
      (item) => `
        <div class="progress-row">
          <div class="progress-row-meta">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${uploadStatusText(item.status)} · ${formatSize(item.size)}${item.error ? ` · ${escapeHtml(item.error)}` : ""}</span>
          </div>
          <div class="progress-track"><i style="width:${clamp(item.progress, 0, 100)}%"></i></div>
          <span class="progress-value">${clamp(item.progress, 0, 100)}%</span>
        </div>
      `,
    )
    .join("");
}

function uploadStatusText(status) {
  return {
    queued: "等待上传",
    uploading: "上传中",
    processing: "服务器解析中",
    completed: "完成",
    failed: "失败",
    skipped: "文件过大",
  }[status] || status;
}

function renderTextbookList() {
  fileList.innerHTML = "";
  state.textbooks.forEach((book) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `file-card ${state.activeBook?.textbook_id === book.textbook_id ? "active" : ""}`;
    card.innerHTML = `
      <div class="file-title-row">
        <strong>${escapeHtml(book.filename)}</strong>
        <span class="delete-button" role="button" tabindex="0" title="删除教材" data-delete-id="${book.textbook_id}">×</span>
      </div>
      <div class="file-meta">
        <span>${book.format.toUpperCase()}</span>
        <span>${formatSize(book.size)}</span>
        <span>${book.chapter_count} 章</span>
        <span>${formatNumber(book.total_chars)} 字</span>
      </div>
      <span class="status-pill ${book.status}">${statusText(book.status)}</span>
      ${book.error ? `<small class="muted-text">${escapeHtml(book.error)}</small>` : ""}
    `;
    card.addEventListener("click", () => selectBook(book.textbook_id));
    card.querySelector("[data-delete-id]").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteBook(book.textbook_id, book.filename);
    });
    fileList.appendChild(card);
  });
}

function renderGraphScopeOptions() {
  graphScopeSelect.innerHTML = `<option value="all">全部教材</option>`;
  state.textbooks.forEach((book) => {
    const option = document.createElement("option");
    option.value = book.textbook_id;
    option.textContent = book.title || book.filename;
    graphScopeSelect.appendChild(option);
  });
  graphScopeSelect.disabled = !state.textbooks.length;
  if (state.activeBook?.textbook_id) graphScopeSelect.value = state.activeBook.textbook_id;
}

async function selectBook(textbookId) {
  const response = await fetch(`/api/textbooks/${encodeURIComponent(textbookId)}`);
  state.activeBook = await response.json();
  state.activeChapterId = state.activeBook.chapters[0]?.chapter_id || null;
  graphScopeSelect.value = textbookId;
  renderActiveBook();
}

async function deleteBook(textbookId, filename) {
  if (!confirm(`删除 ${filename}？解析结果、上传文件和已生成图谱都会移除。`)) return;
  const response = await fetch(`/api/textbooks/${encodeURIComponent(textbookId)}`, { method: "DELETE" });
  if (!response.ok) {
    alert("删除失败");
    return;
  }
  if (state.activeBook?.textbook_id === textbookId) {
    state.activeBook = null;
    state.activeChapterId = null;
    resetPreview();
  }
  await loadTextbooks();
}

function renderStats() {
  const totalChapters = state.textbooks.reduce((sum, book) => sum + book.chapter_count, 0);
  const totalChars = state.textbooks.reduce((sum, book) => sum + book.total_chars, 0);
  bookCount.textContent = state.textbooks.length;
  chapterCount.textContent = formatNumber(totalChapters);
  charCount.textContent = formatCompact(totalChars);
}

function renderActiveBook() {
  renderTextbookList();
  const book = state.activeBook;
  if (!book) return;

  activeTitle.textContent = book.title || book.filename;
  exportButton.disabled = false;
  graphButton.disabled = !state.textbooks.length;
  parseStatus.textContent = "已完成";
  parseStatus.className = "status-pill";
  chapterList.className = "chapter-list";
  chapterList.innerHTML = "";
  (book.chapters || []).forEach((chapter) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `chapter-row ${chapter.chapter_id === state.activeChapterId ? "active" : ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(chapter.title)}</strong>
      <span>${pageRange(chapter)} · ${formatNumber(chapter.char_count)} 字</span>
    `;
    row.addEventListener("click", () => {
      state.activeChapterId = chapter.chapter_id;
      renderActiveBook();
    });
    chapterList.appendChild(row);
  });
}

async function buildKnowledgeGraphByScope() {
  const targets = getBuildTargets();
  if (!targets.length) {
    graphStatus.textContent = "请先上传教材";
    graphStatus.className = "status-pill failed";
    return;
  }

  setGraphBusy(true);
  renderBuildProgress(makeBuildSteps(targets));

  try {
    const builtGraphs = [];
    updateBuildStep("parse", "completed");
    for (const target of targets) {
      updateBuildStep(`extract:${target.textbook_id}`, "active", `正在抽取：${target.title || target.filename}`);
      builtGraphs.push(await postBuildGraph(target, (job) => updateBookProgressStep(target, job)));
      updateBuildStep(`extract:${target.textbook_id}`, "completed", `已完成：${target.title || target.filename}`);
    }
    updateBuildStep("relations", "active");
    await sleep(250);
    updateBuildStep("relations", "completed");
    updateBuildStep("merge", "active");
    if (graphScopeSelect.value === "all") {
      await loadAggregateGraph();
    } else {
      state.graph = graphToAggregate(builtGraphs[0]);
      state.selectedNodeId = null;
      ensureGraphPositions();
      renderKnowledgeGraph();
    }
    updateBuildStep("merge", "completed");
    updateBuildStep("render", "completed");
    graphStatus.textContent = "已生成";
    graphStatus.className = "status-pill";
  } catch (error) {
    const activeStep = state.buildSteps.find((step) => step.status === "active");
    if (activeStep) updateBuildStep(activeStep.id, "failed", error.message || "构建失败");
    graphStatus.textContent = "生成失败";
    graphStatus.className = "status-pill failed";
    alert(error.message || "知识图谱生成失败");
  } finally {
    setGraphBusy(false);
  }
}

function getBuildTargets() {
  const completed = state.textbooks.filter((book) => book.status === "completed" && book.chapter_count > 0);
  if (graphScopeSelect.value === "all") return completed;
  return completed.filter((book) => book.textbook_id === graphScopeSelect.value);
}

async function postBuildGraph(book, onProgress) {
  const startResponse = await fetch(`/api/textbooks/${encodeURIComponent(book.textbook_id)}/knowledge-graph/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_chapters: book.chapter_count || 1,
      force: true,
    }),
  });
  let job = await startResponse.json();
  if (!startResponse.ok) throw new Error(job.detail || `构建失败：${book.title || book.filename}`);
  onProgress?.(job);

  while (job.status === "queued" || job.status === "running") {
    await sleep(1000);
    const progressResponse = await fetch(`/api/knowledge-graph/jobs/${encodeURIComponent(job.job_id)}`);
    job = await progressResponse.json();
    if (!progressResponse.ok) throw new Error(job.detail || `获取构建进度失败：${book.title || book.filename}`);
    onProgress?.(job);
  }

  if (job.status !== "completed") {
    throw new Error(job.error || job.message || `构建失败：${book.title || book.filename}`);
  }
  return job.graph;
}

function defaultBuildSteps() {
  return [
    { id: "parse", label: "文件解析", detail: "章节识别、文本提取", status: "pending" },
    { id: "extract", label: "知识点提取", detail: "LLM 抽取章节知识点", status: "pending" },
    { id: "relations", label: "关系识别", detail: "构建知识点之间的关系", status: "pending" },
    { id: "merge", label: "跨教材整合", detail: "识别等价/冲突知识点", status: "pending" },
    { id: "render", label: "图谱渲染", detail: "更新浏览器可视化", status: "pending" },
  ];
}

function makeBuildSteps(targets) {
  return [
    { id: "parse", label: "文件解析", detail: "已解析教材章节与正文", status: "pending" },
    ...targets.map((book) => ({
      id: `extract:${book.textbook_id}`,
      label: `知识点提取：${book.title || book.filename}`,
      detail: `${book.chapter_count} 章，逐章调用 LLM`,
      status: "pending",
    })),
    { id: "relations", label: "关系识别", detail: "前置依赖、并列、包含、应用关系", status: "pending" },
    { id: "merge", label: targets.length > 1 ? "跨教材整合" : "单教材图谱整理", detail: "统计频次、来源与节点合并", status: "pending" },
    { id: "render", label: "图谱渲染", detail: "刷新节点、边、图例与详情面板", status: "pending" },
  ];
}

function renderBuildProgress(steps) {
  state.buildSteps = steps;
  const completed = steps.filter((step) => step.status === "completed").length;
  const failed = steps.some((step) => step.status === "failed");
  const percent = steps.length ? Math.round((completed / steps.length) * 100) : 0;
  buildProgressPercent.textContent = failed ? "失败" : `${percent}%`;
  buildProgressPercent.className = `status-pill ${failed ? "failed" : percent === 100 ? "" : "muted"}`;
  buildProgressSteps.innerHTML = steps
    .map(
      (step) => {
        const chapters = step.chapters?.length
          ? `
            <div class="chapter-progress-list">
              ${step.chapters
                .map(
                  (chapter) => `
                    <div class="chapter-progress-row ${chapter.status}">
                      <span>${escapeHtml(chapter.title)}</span>
                      <strong>${chapter.chunks_done || 0}/${chapter.chunks_total || 0}</strong>
                    </div>
                  `,
                )
                .join("")}
            </div>
          `
          : "";
        return `
        <div class="build-step ${step.status}">
          <i></i>
          <div>
            <strong>${escapeHtml(step.label)}</strong>
            <span>${escapeHtml(step.detail)}</span>
            ${chapters}
          </div>
        </div>
      `;
      },
    )
    .join("");
}

function updateBuildStep(id, status, detail) {
  state.buildSteps = state.buildSteps.map((step) => (step.id === id ? { ...step, status, detail: detail || step.detail } : step));
  renderBuildProgress(state.buildSteps);
}

function updateBookProgressStep(book, job) {
  const done = (job.chapters || []).filter((chapter) => chapter.status === "completed").length;
  const failed = (job.chapters || []).filter((chapter) => chapter.status === "failed").length;
  const total = (job.chapters || []).length || book.chapter_count || 0;
  const detail = `${job.progress || 0}% · 章节 ${done}/${total}${failed ? ` · 失败 ${failed}` : ""} · ${job.message || "抽取中"}`;
  state.buildSteps = state.buildSteps.map((step) =>
    step.id === `extract:${book.textbook_id}`
      ? {
          ...step,
          status: job.status === "failed" ? "failed" : job.status === "completed" ? "completed" : "active",
          detail,
          chapters: job.chapters || [],
        }
      : step,
  );
  renderBuildProgress(state.buildSteps);
}

function setUploading(isUploading) {
  parseStatus.textContent = isUploading ? "解析中" : state.activeBook ? "已完成" : "待解析";
  parseStatus.className = `status-pill ${isUploading ? "parsing" : state.activeBook ? "" : "muted"}`;
}

function setGraphBusy(isBusy) {
  graphButton.disabled = isBusy || !state.textbooks.length;
  graphScopeSelect.disabled = isBusy || !state.textbooks.length;
  graphMergeModeSelect.disabled = isBusy;
  if (isBusy) {
    graphStatus.textContent = "生成中";
    graphStatus.className = "status-pill parsing";
  }
}

function renderKnowledgeGraph() {
  graphSvg.innerHTML = "";
  graphMatrix.innerHTML = "";
  renderLegend();
  renderGraphViewControls();
  if (!state.graph || !state.graph.nodes.length) {
    graphStatus.textContent = "未生成";
    graphStatus.className = "status-pill muted";
    graphStats.textContent = "选择构建范围后点击生成。";
    graphSvg.classList.remove("hidden");
    graphMatrix.classList.add("hidden");
    renderNodeDetail(null);
    return;
  }

  ensureGraphPositions();
  const visibleNodes = state.graph.nodes.slice(0, GRAPH_NODE_LIMIT);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const filteredEdges = filteredGraphEdges(state.graph, visibleIds);
  graphStatus.textContent = "可交互";
  graphStatus.className = "status-pill";
  const mergeHint =
    state.graph.merge_mode === "merged" && state.graph.raw_node_count
      ? ` · 已由 ${state.graph.raw_node_count} 个原始节点融合为 ${state.graph.merged_node_count || state.graph.nodes.length} 个`
      : " · 原始来源视图";
  graphStats.textContent = `${state.graph.nodes.length} 个知识点 · ${filteredEdges.length}/${state.graph.edges.length} 条关系 · ${state.graph.textbook_count} 本教材来源${mergeHint}`;
  if (state.graphView === "matrix") {
    graphSvg.classList.add("hidden");
    graphMatrix.classList.remove("hidden");
    renderKnowledgeMatrix(state.graph, visibleNodes, filteredEdges);
  } else if (state.graphView === "heatmap") {
    graphSvg.classList.add("hidden");
    graphMatrix.classList.remove("hidden");
    renderAdjacencyHeatmap(state.graph, visibleNodes, filteredEdges);
  } else {
    graphSvg.classList.remove("hidden");
    graphMatrix.classList.add("hidden");
    drawGraph(state.graph, visibleNodes, filteredEdges);
  }
  renderNodeDetail(state.graph.nodes.find((node) => node.id === state.selectedNodeId) || null);
}

function drawGraph(graph, visibleNodes, filteredEdges) {
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const { width, height } = graphCanvasSize(visibleNodes);
  const query = state.searchQuery;

  graphSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graphSvg.appendChild(svgElement("rect", { width, height, class: "graph-background" }));
  const viewport = svgElement("g", {
    class: "graph-viewport",
    transform: `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`,
  });
  graphSvg.appendChild(viewport);

  filteredEdges.forEach((edge) => {
    const source = state.graphPositions.get(edge.source);
    const target = state.graphPositions.get(edge.target);
    if (!source || !target) return;
    viewport.appendChild(
      svgElement("line", {
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        class: `graph-edge ${edge.relation_type}`,
        "stroke-width": Math.min(1 + (edge.frequency || 1) * 0.45, 4),
        "data-source": edge.source,
        "data-target": edge.target,
      }),
    );
  });

  visibleNodes.forEach((node) => {
    const pos = state.graphPositions.get(node.id);
    const matches = query && searchableText(node).includes(query);
    const dimmed = query && !matches;
    const selected = state.selectedNodeId === node.id;
    const radius = nodeRadius(node);
    const labeled = shouldShowNodeLabel(node, selected, matches, query);
    const group = svgElement("g", {
      class: `graph-node ${selected ? "selected" : ""} ${matches ? "matched" : ""} ${dimmed ? "dimmed" : ""} ${labeled ? "labeled" : ""}`,
      transform: `translate(${pos.x} ${pos.y})`,
      "data-node-id": node.id,
      tabindex: "0",
      role: "button",
    });
    group.appendChild(svgElement("circle", { r: radius + 16, class: "node-hit-area" }));
    group.appendChild(nodeShapeElement(node, radius));
    group.appendChild(svgElement("circle", { r: Math.max(radius - 7, 5), class: "node-core" }));
    sourceMarkers(node, radius).forEach((marker) => group.appendChild(marker));
    const text = svgElement("text", { y: radius + 16, "text-anchor": "middle" });
    text.textContent = node.name.length > 10 ? `${node.name.slice(0, 10)}...` : node.name;
    group.appendChild(text);
    group.appendChild(svgElement("title", {}, `${node.name}\n出现 ${node.frequency} 次\n${node.definition}`));
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectGraphNode(node.id);
    });
    group.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      const point = graphPoint(event);
      state.pointer = {
        mode: "node",
        nodeId: node.id,
        start: point,
        origin: { ...pos },
        moved: false,
        pointerId: event.pointerId,
      };
      graphSvg.setPointerCapture(event.pointerId);
    });
    viewport.appendChild(group);
  });
}

function filteredGraphEdges(graph, visibleIds) {
  return graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target) && state.relationFilter.has(edge.relation_type));
}

function renderGraphViewControls() {
  graphViewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.graphView === state.graphView);
  });
  relationFilterInputs.forEach((input) => {
    input.checked = state.relationFilter.has(input.value);
  });
}

function nodeShapeElement(node, radius) {
  const shape = categoryShape(node).shape;
  const attributes = {
    class: `node-shape ${shape}`,
    fill: sourceColor(node),
    "fill-opacity": nodeOpacity(node),
  };
  if (shape === "circle") return svgElement("circle", { ...attributes, r: radius });
  if (shape === "square") {
    return svgElement("rect", {
      ...attributes,
      x: -radius,
      y: -radius,
      width: radius * 2,
      height: radius * 2,
      rx: Math.max(4, radius * 0.18),
    });
  }
  return svgElement("polygon", { ...attributes, points: shapePoints(shape, radius) });
}

function shapePoints(shape, radius) {
  if (shape === "triangle") {
    return `0 ${-radius} ${radius * 0.92} ${radius * 0.78} ${-radius * 0.92} ${radius * 0.78}`;
  }
  if (shape === "diamond") {
    return `0 ${-radius} ${radius} 0 0 ${radius} ${-radius} 0`;
  }
  if (shape === "hexagon") {
    return `0 ${-radius} ${radius * 0.86} ${-radius * 0.5} ${radius * 0.86} ${radius * 0.5} 0 ${radius} ${-radius * 0.86} ${radius * 0.5} ${-radius * 0.86} ${-radius * 0.5}`;
  }
  return `0 ${-radius} ${radius} 0 0 ${radius} ${-radius} 0`;
}

function categoryShape(node) {
  const category = String(node.category || node.name || "").toLowerCase();
  return CATEGORY_SHAPES.find((item) => item.keywords.some((keyword) => category.includes(keyword.toLowerCase()))) || {
    key: "concept",
    label: "概念/术语",
    shape: "circle",
  };
}

function renderKnowledgeMatrix(graph, visibleNodes, filteredEdges) {
  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
  const rows = matrixRows(visibleNodes);
  const columns = matrixColumns(visibleNodes);
  const cells = new Map();

  rows.forEach((row) => {
    columns.forEach((column) => {
      cells.set(matrixKey(row.id, column.key), { nodeIds: new Set(), relationCount: 0 });
    });
  });

  visibleNodes.forEach((node) => {
    const column = categoryShape(node).key;
    nodeSourceIds(node).forEach((sourceId) => {
      const cell = cells.get(matrixKey(sourceId, column));
      if (cell) cell.nodeIds.add(node.id);
    });
  });

  filteredEdges.forEach((edge) => {
    [nodeById.get(edge.source), nodeById.get(edge.target)].filter(Boolean).forEach((node) => {
      const column = categoryShape(node).key;
      nodeSourceIds(node).forEach((sourceId) => {
        const cell = cells.get(matrixKey(sourceId, column));
        if (cell) cell.relationCount += edge.frequency || 1;
      });
    });
  });

  const maxRelationCount = Math.max(1, ...Array.from(cells.values()).map((cell) => cell.relationCount));
  graphMatrix.innerHTML = `
    <div class="matrix-summary">
      <strong>知识矩阵</strong>
      <span>按教材来源 × 知识类别聚合，颜色越深表示该类别关联越密集。</span>
    </div>
    <div class="matrix-scroll">
      <table class="matrix-table">
        <thead>
          <tr>
            <th>教材 / 类别</th>
            ${columns.map((column) => `<th><span class="shape-sample ${column.shape}"></span>${escapeHtml(column.label)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <th>${escapeHtml(row.label)}</th>
                  ${columns
                    .map((column) => {
                      const cell = cells.get(matrixKey(row.id, column.key));
                      const intensity = cell ? cell.relationCount / maxRelationCount : 0;
                      const nodeCount = cell?.nodeIds.size || 0;
                      const relationCount = cell?.relationCount || 0;
                      return `
                        <td>
                          <button class="matrix-cell" type="button" style="--heat:${intensity.toFixed(2)}" title="${escapeHtml(row.label)} · ${escapeHtml(column.label)}">
                            <strong>${formatNumber(nodeCount)}</strong>
                            <span>${formatNumber(relationCount)} 关系</span>
                          </button>
                        </td>
                      `;
                    })
                    .join("")}
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAdjacencyHeatmap(graph, visibleNodes, filteredEdges) {
  const topNodes = topHeatmapNodes(visibleNodes, filteredEdges, 30);
  if (!topNodes.length) {
    graphMatrix.innerHTML = `
      <div class="matrix-summary">
        <strong>邻接热力图</strong>
        <span>当前筛选条件下没有可展示的节点。</span>
      </div>
    `;
    return;
  }

  const nodeIndex = new Map(topNodes.map((node, index) => [node.id, index]));
  const matrix = Array.from({ length: topNodes.length }, () => Array(topNodes.length).fill(0));
  filteredEdges.forEach((edge) => {
    const sourceIndex = nodeIndex.get(edge.source);
    const targetIndex = nodeIndex.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) return;
    const weight = edge.frequency || 1;
    matrix[sourceIndex][targetIndex] += weight;
    matrix[targetIndex][sourceIndex] += weight;
  });

  const size = topNodes.length;
  const cell = 22;
  const labelWidth = 164;
  const topLabelHeight = 152;
  const width = labelWidth + size * cell + 24;
  const height = topLabelHeight + size * cell + 24;
  const maxWeight = Math.max(1, ...matrix.flat());
  const labels = topNodes
    .map((node, index) => {
      const label = escapeHtml(shortNodeLabel(node.name, 11));
      const y = topLabelHeight + index * cell + cell * 0.66;
      const x = labelWidth + index * cell + cell / 2;
      return `
        <text class="heatmap-row-label" x="${labelWidth - 10}" y="${y}" text-anchor="end">${label}</text>
        <text class="heatmap-column-label" x="${x}" y="${topLabelHeight - 10}" transform="rotate(-58 ${x} ${topLabelHeight - 10})">${label}</text>
      `;
    })
    .join("");

  const cells = matrix
    .map((row, rowIndex) =>
      row
        .map((value, columnIndex) => {
          const node = topNodes[rowIndex];
          const target = topNodes[columnIndex];
          const opacity = value ? 0.16 + (value / maxWeight) * 0.72 : 0.04;
          return `
            <rect
              class="heatmap-cell"
              x="${labelWidth + columnIndex * cell}"
              y="${topLabelHeight + rowIndex * cell}"
              width="${cell - 2}"
              height="${cell - 2}"
              fill-opacity="${opacity.toFixed(2)}"
              data-node-id="${node.id}"
            >
              <title>${escapeHtml(node.name)} → ${escapeHtml(target.name)}：${formatNumber(value)} 条关系</title>
            </rect>
          `;
        })
        .join(""),
    )
    .join("");

  graphMatrix.innerHTML = `
    <div class="matrix-summary">
      <strong>邻接热力图</strong>
      <span>Top ${topNodes.length} 高频知识点 × Top ${topNodes.length} 高频知识点，颜色越深表示关系越密集。</span>
    </div>
    <div class="heatmap-scroll">
      <svg class="adjacency-heatmap" viewBox="0 0 ${width} ${height}" role="img" aria-label="Top ${topNodes.length} 知识点邻接矩阵">
        <rect class="heatmap-bg" width="${width}" height="${height}"></rect>
        ${labels}
        ${cells}
      </svg>
    </div>
  `;

  graphMatrix.querySelectorAll(".heatmap-cell").forEach((cellElement) => {
    cellElement.addEventListener("click", () => {
      selectGraphNode(cellElement.dataset.nodeId);
    });
  });
}

function topHeatmapNodes(nodes, edges, limit) {
  const relationDegree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => {
    const weight = edge.frequency || 1;
    relationDegree.set(edge.source, (relationDegree.get(edge.source) || 0) + weight);
    relationDegree.set(edge.target, (relationDegree.get(edge.target) || 0) + weight);
  });
  return [...nodes]
    .sort((a, b) => {
      const bScore = (relationDegree.get(b.id) || 0) + (b.frequency || 1) * 0.8 + (b.textbook_count || 1) * 2;
      const aScore = (relationDegree.get(a.id) || 0) + (a.frequency || 1) * 0.8 + (a.textbook_count || 1) * 2;
      return bScore - aScore;
    })
    .slice(0, limit);
}

function shortNodeLabel(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function matrixRows(nodes) {
  const rows = new Map();
  nodes.forEach((node) => {
    const ids = nodeSourceIds(node);
    const titles = node.textbook_titles || [];
    ids.forEach((id, index) => {
      if (!rows.has(id)) {
        const known = state.textbooks.find((book) => book.textbook_id === id);
        rows.set(id, { id, label: known?.title || titles[index] || "未知教材" });
      }
    });
  });
  return Array.from(rows.values());
}

function matrixColumns(nodes) {
  const seen = new Set();
  const columns = [];
  nodes.forEach((node) => {
    const shape = categoryShape(node);
    if (seen.has(shape.key)) return;
    seen.add(shape.key);
    columns.push(shape);
  });
  return columns.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function nodeSourceIds(node) {
  return node.textbook_ids?.length ? node.textbook_ids : ["unknown"];
}

function matrixKey(rowId, columnKey) {
  return `${rowId}::${columnKey}`;
}

function ensureGraphPositions() {
  if (!state.graph) return;
  const visibleNodes = state.graph.nodes.slice(0, GRAPH_NODE_LIMIT);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = state.graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const layoutKey = [
    visibleNodes.map((node) => `${node.id}:${node.name}:${node.frequency}:${node.textbook_ids?.join(",")}`).join("|"),
    visibleEdges.map((edge) => `${edge.source}>${edge.target}:${edge.relation_type}:${edge.frequency || 1}`).join("|"),
  ].join("::");
  const hasPositions = visibleNodes.every((node) => state.graphPositions.has(node.id));
  if (state.graphLayoutKey === layoutKey && hasPositions) return;

  state.graphLayoutKey = layoutKey;
  state.graphPositions = computeConnectedPapersLayout(visibleNodes, visibleEdges);
  state.view = { scale: 1, x: 0, y: 0 };
}

function graphCanvasSize(nodes) {
  const count = Math.max(nodes.length, 1);
  const scale = Math.sqrt(count);
  return {
    width: Math.max(1700, Math.round(1050 + scale * 145)),
    height: Math.max(1120, Math.round(820 + scale * 108)),
  };
}

function computeConnectedPapersLayout(nodes, edges) {
  const { width, height } = graphCanvasSize(nodes);
  const center = { x: width / 2, y: height / 2 };
  const groups = groupNodesBySource(nodes);
  const clusterCenters = sourceClusterCenters(groups, width, height);
  const nodeState = new Map();
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  });

  groups.forEach((group, groupIndex) => {
    const groupCenter = clusterCenters.get(group.sourceId) || center;
    group.nodes.forEach((node, nodeIndex) => {
      const seed = hashString(`${node.id}:${node.name}`);
      const angle = seededAngle(seed + nodeIndex * 997);
      const ring = 100 + Math.sqrt(nodeIndex + 1) * 72;
      const centrality = Math.min((degree.get(node.id) || 0) + (node.frequency || 1), 18);
      const centerBias = centrality / 18;
      nodeState.set(node.id, {
        node,
        x: groupCenter.x * (1 - centerBias * 0.28) + center.x * centerBias * 0.28 + Math.cos(angle) * ring,
        y: groupCenter.y * (1 - centerBias * 0.28) + center.y * centerBias * 0.28 + Math.sin(angle) * ring,
        vx: 0,
        vy: 0,
        radius: nodeRadius(node),
        cluster: group.sourceId,
        groupIndex,
      });
    });
  });

  const layoutNodes = Array.from(nodeState.values());
  const links = edges
    .map((edge) => ({ ...edge, sourceNode: nodeState.get(edge.source), targetNode: nodeState.get(edge.target) }))
    .filter((edge) => edge.sourceNode && edge.targetNode);

  for (let iteration = 0; iteration < 360; iteration += 1) {
    const cooling = 1 - iteration / 360;

    for (let i = 0; i < layoutNodes.length; i += 1) {
      const a = layoutNodes[i];
      for (let j = i + 1; j < layoutNodes.length; j += 1) {
        const b = layoutNodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy || 0.01;
        const distance = Math.sqrt(distanceSq);
        const minDistance = a.radius + b.radius + 86;
        const repel = Math.min(18000 / distanceSq, 5.2) * cooling;
        dx /= distance;
        dy /= distance;
        a.vx -= dx * repel;
        a.vy -= dy * repel;
        b.vx += dx * repel;
        b.vy += dy * repel;

        if (distance < minDistance) {
          const push = (minDistance - distance) * 0.09 * cooling;
          a.vx -= dx * push;
          a.vy -= dy * push;
          b.vx += dx * push;
          b.vy += dy * push;
        }
      }
    }

    links.forEach((edge) => {
      const source = edge.sourceNode;
      const target = edge.targetNode;
      let dx = target.x - source.x;
      let dy = target.y - source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const desired = relationDistance(edge.relation_type) + source.radius + target.radius - Math.min(edge.frequency || 1, 6) * 5;
      const strength = relationStrength(edge.relation_type) * Math.min(edge.frequency || 1, 4) * cooling;
      const pull = ((distance - desired) / distance) * strength;
      dx *= pull;
      dy *= pull;
      source.vx += dx;
      source.vy += dy;
      target.vx -= dx;
      target.vy -= dy;
    });

    layoutNodes.forEach((item) => {
      const groupCenter = clusterCenters.get(item.cluster) || center;
      const centrality = Math.min((degree.get(item.node.id) || 0) + (item.node.frequency || 1), 18) / 18;
      item.vx += (center.x - item.x) * (0.002 + centrality * 0.004) * cooling;
      item.vy += (center.y - item.y) * (0.002 + centrality * 0.004) * cooling;
      item.vx += (groupCenter.x - item.x) * 0.0015 * cooling;
      item.vy += (groupCenter.y - item.y) * 0.0015 * cooling;
      item.vx *= 0.76;
      item.vy *= 0.76;
      item.x += clamp(item.vx, -24, 24);
      item.y += clamp(item.vy, -24, 24);
    });
  }

  fitLayoutToCanvas(layoutNodes, width, height);
  return new Map(layoutNodes.map((item) => [item.node.id, { x: item.x, y: item.y }]));
}

function sourceClusterCenters(groups, width, height) {
  const centers = new Map();
  const center = { x: width / 2, y: height / 2 };
  if (groups.length <= 1) {
    groups.forEach((group) => centers.set(group.sourceId, center));
    return centers;
  }

  const radius = Math.min(width, height) * 0.35;
  groups.forEach((group, index) => {
    const angle = -Math.PI / 2 + (index / groups.length) * Math.PI * 2;
    centers.set(group.sourceId, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius * 0.76,
    });
  });
  return centers;
}

function fitLayoutToCanvas(layoutNodes, width, height) {
  if (!layoutNodes.length) return;
  const padding = 150;
  const minX = Math.min(...layoutNodes.map((item) => item.x - item.radius));
  const maxX = Math.max(...layoutNodes.map((item) => item.x + item.radius));
  const minY = Math.min(...layoutNodes.map((item) => item.y - item.radius));
  const maxY = Math.max(...layoutNodes.map((item) => item.y + item.radius));
  const scale = Math.min((width - padding * 2) / Math.max(maxX - minX, 1), (height - padding * 2) / Math.max(maxY - minY, 1), 1.05);
  const offsetX = width / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = height / 2 - ((minY + maxY) / 2) * scale;
  layoutNodes.forEach((item) => {
    item.x = item.x * scale + offsetX;
    item.y = item.y * scale + offsetY;
  });
}

function relationDistance(type) {
  return {
    prerequisite: 245,
    parallel: 210,
    contains: 185,
    applies_to: 230,
  }[type] || 220;
}

function relationStrength(type) {
  return {
    prerequisite: 0.018,
    parallel: 0.014,
    contains: 0.022,
    applies_to: 0.016,
  }[type] || 0.016;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededAngle(seed) {
  return ((seed % 10000) / 10000) * Math.PI * 2;
}

function groupNodesBySource(nodes) {
  const groupMap = new Map();
  nodes.forEach((node) => {
    const sourceId = node.textbook_ids?.[0] || "unknown";
    if (!groupMap.has(sourceId)) groupMap.set(sourceId, []);
    groupMap.get(sourceId).push(node);
  });
  return Array.from(groupMap.entries()).map(([sourceId, groupNodes]) => ({
    sourceId,
    nodes: groupNodes.sort((a, b) => (b.frequency || 0) - (a.frequency || 0)),
  }));
}

function renderLegend() {
  graphLegend.innerHTML = "";
  const sourceGroup = document.createElement("div");
  sourceGroup.className = "legend-group";
  sourceGroup.innerHTML = "<strong>教材来源</strong>";
  state.textbooks.forEach((book, index) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `<i style="background:${SOURCE_COLORS[index % SOURCE_COLORS.length]}"></i>${escapeHtml(book.title || book.filename)}`;
    sourceGroup.appendChild(item);
  });

  const relationGroup = document.createElement("div");
  relationGroup.className = "legend-group";
  relationGroup.innerHTML = `
    <strong>关系类型</strong>
    ${RELATION_ORDER.map((type) => `<span class="legend-item"><i class="edge-sample ${type}"></i>${RELATION_LABELS[type]}</span>`).join("")}
  `;

  const categoryGroup = document.createElement("div");
  categoryGroup.className = "legend-group";
  categoryGroup.innerHTML = `
    <strong>类别形状</strong>
    <span class="legend-item"><i class="shape-sample circle"></i>概念/术语</span>
    ${CATEGORY_SHAPES.map((item) => `<span class="legend-item"><i class="shape-sample ${item.shape}"></i>${item.label}</span>`).join("")}
  `;

  const frequencyGroup = document.createElement("div");
  frequencyGroup.className = "legend-group";
  frequencyGroup.innerHTML = `
    <strong>频次</strong>
    <span class="legend-item frequency-sample"><i class="freq-dot low"></i>低频</span>
    <span class="legend-item frequency-sample"><i class="freq-dot mid"></i>中频</span>
    <span class="legend-item frequency-sample"><i class="freq-dot high"></i>高频</span>
    <span class="legend-note">节点越大、颜色越深，表示出现次数越多</span>
  `;
  graphLegend.append(sourceGroup, relationGroup, categoryGroup, frequencyGroup);
}

function renderNodeDetail(node) {
  if (!node) {
    detailFrequency.textContent = "未选择";
    detailFrequency.className = "status-pill muted";
    nodeDetail.className = "node-detail empty";
    nodeDetail.textContent = "点击任意节点查看名称、定义、所在章节、原文出处和关联关系。";
    return;
  }

  detailFrequency.textContent = `出现 ${node.frequency} 次`;
  detailFrequency.className = "status-pill";
  nodeDetail.className = "node-detail";
  const relations = nodeRelations(node.id);
  const sources = node.sources
    .map(
      (source) => `
        <li>
          <strong>${escapeHtml(source.textbook_title)}</strong>
          <span>${escapeHtml(source.chapter || "未知章节")} · ${source.page ? `第 ${source.page} 页` : "无页码"} · 置信度 ${formatPercent(source.confidence ?? node.confidence ?? 1)}</span>
          <p>${escapeHtml(source.source_excerpt || source.definition || "暂无原文摘录")}</p>
        </li>
      `,
    )
    .join("");
  const relationHtml = RELATION_ORDER.map((relationType) => {
    const items = relations.filter((relation) => relation.relation_type === relationType);
    if (!items.length) return "";
    return `
      <section class="relation-section">
        <h6><i class="edge-sample ${relationType}"></i>${relationLabel(relationType)}</h6>
        <ul>
          ${items
            .map(
              (relation) => `
                <li>
                  <strong>${escapeHtml(relation.direction)}：${escapeHtml(relation.otherNode?.name || "未知节点")}</strong>
                  <span>${escapeHtml(relation.otherNode?.category || "未分类")}</span>
                  <p>${escapeHtml(relation.description || "暂无关系说明")}</p>
                </li>
              `,
            )
            .join("")}
        </ul>
      </section>
    `;
  }).join("");

  nodeDetail.innerHTML = `
    <h4>${escapeHtml(node.name)}</h4>
    <dl>
      <dt>定义</dt>
      <dd>${escapeHtml(node.definition || "暂无定义")}</dd>
      <dt>类别</dt>
      <dd>${escapeHtml(node.category || "未分类")}</dd>
      <dt>出现频次</dt>
      <dd>${formatNumber(node.frequency || 0)} 次，覆盖 ${formatNumber(node.textbook_count || 0)} 本教材</dd>
      <dt>抽取置信度</dt>
      <dd>${formatPercent(node.confidence ?? 1)}</dd>
      <dt>教材来源</dt>
      <dd>${node.textbook_titles.map(escapeHtml).join("、")}</dd>
    </dl>
    <h5>关联关系</h5>
    ${relationHtml || '<p class="muted-text">暂无与该节点相连的关系。</p>'}
    <h5>原文出处</h5>
    <ul>${sources}</ul>
  `;
}

function nodeRelations(nodeId) {
  if (!state.graph?.edges?.length) return [];
  const nodeById = new Map(state.graph.nodes.map((node) => [node.id, node]));
  return state.graph.edges
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .map((edge) => {
      const isSource = edge.source === nodeId;
      const otherId = isSource ? edge.target : edge.source;
      return { ...edge, direction: relationDirection(edge.relation_type, isSource), otherNode: nodeById.get(otherId) };
    });
}

function relationLabel(type) {
  return {
    prerequisite: "前置依赖",
    parallel: "并列关系",
    contains: "包含关系",
    applies_to: "应用关系",
  }[type] || type;
}

function relationDirection(type, isSource) {
  if (type === "prerequisite") return isSource ? "它是对方的前置知识" : "依赖该知识点";
  if (type === "contains") return isSource ? "包含" : "属于";
  if (type === "applies_to") return isSource ? "应用于" : "被应用于";
  if (type === "parallel") return "并列";
  return isSource ? "指向" : "来自";
}

function graphToAggregate(graph) {
  return {
    textbook_count: 1,
    nodes: graph.nodes.map((node, index) => ({
      id: `agg_node_${String(index + 1).padStart(3, "0")}`,
      name: node.name,
      definition: node.definition,
      category: node.category,
      frequency: 1,
      textbook_count: 1,
      textbook_ids: [graph.textbook_id],
      textbook_titles: [graph.title],
      confidence: node.confidence ?? 1,
      sources: [{ textbook_id: graph.textbook_id, textbook_title: graph.title, chapter: node.chapter, page: node.page, definition: node.definition, source_excerpt: node.source_excerpt, confidence: node.confidence ?? 1, node_id: node.id }],
      original_id: node.id,
    })),
    edges: graph.edges.map((edge) => ({
      source: nodeAggregateId(graph.nodes, edge.source),
      target: nodeAggregateId(graph.nodes, edge.target),
      relation_type: edge.relation_type,
      description: edge.description,
      frequency: 1,
      textbook_ids: [graph.textbook_id],
      textbook_titles: [graph.title],
    })),
  };
}

function nodeAggregateId(nodes, nodeId) {
  const index = nodes.findIndex((node) => node.id === nodeId);
  return `agg_node_${String(index + 1).padStart(3, "0")}`;
}

function selectGraphNode(nodeId) {
  if (!nodeId || !state.graph?.nodes.some((node) => node.id === nodeId)) return;
  state.selectedNodeId = nodeId;
  renderKnowledgeGraph();
}

function onGraphClick(event) {
  if (state.suppressGraphClick) {
    state.suppressGraphClick = false;
    return;
  }
  const nodeElement = event.target.closest?.(".graph-node");
  if (!nodeElement) return;
  event.stopPropagation();
  selectGraphNode(nodeElement.dataset.nodeId);
}

function onGraphWheel(event) {
  event.preventDefault();
  const oldScale = state.view.scale;
  const nextScale = clamp(oldScale * Math.exp(-event.deltaY * GRAPH_WHEEL_ZOOM_SPEED), GRAPH_MIN_SCALE, GRAPH_MAX_SCALE);
  const point = svgPoint(event);
  state.view.x = point.x - ((point.x - state.view.x) / oldScale) * nextScale;
  state.view.y = point.y - ((point.y - state.view.y) / oldScale) * nextScale;
  state.view.scale = nextScale;
  applyGraphView();
}

function onGraphPointerDown(event) {
  if (event.target.closest?.(".graph-node")) return;
  event.preventDefault();
  state.pointer = {
    mode: "pan",
    start: svgPoint(event),
    origin: { x: state.view.x, y: state.view.y },
    pointerId: event.pointerId,
    moved: false,
  };
  graphSvg.setPointerCapture(event.pointerId);
}

function onGraphPointerMove(event) {
  if (!state.pointer) return;
  event.preventDefault();
  if (state.pointer.mode === "pan") {
    const point = svgPoint(event);
    const dx = point.x - state.pointer.start.x;
    const dy = point.y - state.pointer.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) state.pointer.moved = true;
    state.view.x = state.pointer.origin.x + dx;
    state.view.y = state.pointer.origin.y + dy;
    applyGraphView();
    return;
  }
  if (state.pointer.mode === "node") {
    const point = graphPoint(event);
    const dx = point.x - state.pointer.start.x;
    const dy = point.y - state.pointer.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) state.pointer.moved = true;
    const nextPosition = { x: state.pointer.origin.x + dx, y: state.pointer.origin.y + dy };
    state.graphPositions.set(state.pointer.nodeId, nextPosition);
    moveGraphNode(state.pointer.nodeId, nextPosition);
  }
}

function endGraphPointer(event) {
  if (!state.pointer) return;
  if (event?.pointerId !== undefined && state.pointer.pointerId !== event.pointerId) return;
  try {
    if (event?.pointerId !== undefined && graphSvg.hasPointerCapture(event.pointerId)) {
      graphSvg.releasePointerCapture(event.pointerId);
    }
  } catch {
    // Pointer capture may already be released by the browser.
  }
  if (state.pointer.mode === "node" && !state.pointer.moved) {
    selectGraphNode(state.pointer.nodeId);
  }
  if (state.pointer.moved) state.suppressGraphClick = true;
  state.pointer = null;
}

function svgPoint(event) {
  const rect = graphSvg.getBoundingClientRect();
  const viewBox = graphSvg.viewBox.baseVal;
  return {
    x: ((event.clientX - rect.left) / rect.width) * viewBox.width + viewBox.x,
    y: ((event.clientY - rect.top) / rect.height) * viewBox.height + viewBox.y,
  };
}

function graphPoint(event) {
  const point = svgPoint(event);
  return {
    x: (point.x - state.view.x) / state.view.scale,
    y: (point.y - state.view.y) / state.view.scale,
  };
}

function applyGraphView() {
  const viewport = graphSvg.querySelector(".graph-viewport");
  if (viewport) {
    viewport.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`);
  }
}

function moveGraphNode(nodeId, position) {
  const nodeElement = graphSvg.querySelector(`.graph-node[data-node-id="${cssEscape(nodeId)}"]`);
  if (nodeElement) {
    nodeElement.setAttribute("transform", `translate(${position.x} ${position.y})`);
  }

  graphSvg.querySelectorAll(`.graph-edge[data-source="${cssEscape(nodeId)}"]`).forEach((edge) => {
    edge.setAttribute("x1", position.x);
    edge.setAttribute("y1", position.y);
  });
  graphSvg.querySelectorAll(`.graph-edge[data-target="${cssEscape(nodeId)}"]`).forEach((edge) => {
    edge.setAttribute("x2", position.x);
    edge.setAttribute("y2", position.y);
  });
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replaceAll('"', '\\"');
}

function nodeRadius(node) {
  return Math.min(16 + Math.sqrt(node.frequency || 1) * 8 + (node.textbook_count || 1) * 3, 48);
}

function nodeOpacity(node) {
  return Math.min(0.42 + Math.sqrt(node.frequency || 1) * 0.14 + (node.textbook_count || 1) * 0.06, 0.98);
}

function sourceColor(node) {
  const sourceId = node.textbook_ids?.[0];
  const index = Math.max(0, state.textbooks.findIndex((book) => book.textbook_id === sourceId));
  return SOURCE_COLORS[index % SOURCE_COLORS.length];
}

function sourceMarkers(node, radius) {
  const sourceIds = node.textbook_ids || [];
  if (sourceIds.length <= 1) return [];
  const markerRadius = 4.5;
  const totalWidth = (sourceIds.length - 1) * markerRadius * 2.4;
  return sourceIds.slice(0, 6).map((sourceId, index) => {
    const sourceIndex = Math.max(0, state.textbooks.findIndex((book) => book.textbook_id === sourceId));
    return svgElement("circle", {
      class: "source-marker",
      cx: -totalWidth / 2 + index * markerRadius * 2.4,
      cy: -radius - 10,
      r: markerRadius,
      fill: SOURCE_COLORS[sourceIndex % SOURCE_COLORS.length],
    });
  });
}

function searchableText(node) {
  return [node.name, node.definition, node.category, ...(node.textbook_titles || [])].join(" ").toLowerCase();
}

function shouldShowNodeLabel(node, selected, matches, query) {
  if (selected || matches) return true;
  if (query) return false;
  return (node.frequency || 1) >= 3 || (node.textbook_count || 1) >= 2;
}

function resetPreview() {
  activeTitle.textContent = "请选择或上传教材";
  exportButton.disabled = true;
  graphButton.disabled = true;
  parseStatus.textContent = "待解析";
  parseStatus.className = "status-pill muted";
  chapterList.className = "chapter-list empty";
  chapterList.textContent = "上传教材后会显示解析出的章节。";
  renderKnowledgeGraph();
}

function exportActiveBook() {
  if (!state.activeBook) return;
  window.open(`/api/textbooks/${encodeURIComponent(state.activeBook.textbook_id)}/export`, "_blank");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function pageRange(chapter) {
  if (!chapter.page_start && !chapter.page_end) return "无页码";
  if (chapter.page_start === chapter.page_end) return `第 ${chapter.page_start} 页`;
  return `第 ${chapter.page_start}-${chapter.page_end} 页`;
}

function statusText(status) {
  return { parsing: "解析中", completed: "已完成", failed: "失败" }[status] || status;
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatCompact(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return formatNumber(value);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未知";
  return `${Math.round(clamp(number, 0, 1) * 100)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function svgElement(name, attributes = {}, text = "") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  if (text) element.textContent = text;
  return element;
}

const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const chatSubmit = document.querySelector("#chatSubmit");
const chatMessages = document.querySelector("#chatMessages");
const ragStatus = document.querySelector("#ragStatus");

chatForm.addEventListener("submit", sendRagQuery);
chatInput.addEventListener("input", () => {
  chatSubmit.disabled = !chatInput.value.trim();
});

async function sendRagQuery(event) {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;

  addChatMessage("question", question);
  chatInput.value = "";
  chatSubmit.disabled = true;
  ragStatus.textContent = "思考中...";
  ragStatus.className = "status-pill parsing";

  try {
    const body = { question, top_k: 8, history: state.ragHistory.slice(-6) };
    if (graphScopeSelect.value !== "all" && state.activeBook?.textbook_id) {
      body.textbook_ids = [state.activeBook.textbook_id];
    }
    const response = await fetch("/api/rag/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "问答请求失败");
    addChatMessage("answer", data.answer, data.sources || []);
    state.ragHistory.push({ role: "user", content: question }, { role: "assistant", content: data.answer });
    state.ragHistory = state.ragHistory.slice(-8);
    ragStatus.textContent = "就绪";
    ragStatus.className = "status-pill";
  } catch (error) {
    addChatMessage("error", error.message || "问答请求失败");
    ragStatus.textContent = "出错";
    ragStatus.className = "status-pill failed";
  }
}

function addChatMessage(role, content, sources) {
  const placeholder = chatMessages.querySelector(".chat-placeholder");
  if (placeholder) placeholder.remove();

  const msg = document.createElement("div");
  msg.className = `chat-message ${role}`;

  if (role === "answer") {
    const body = document.createElement("div");
    body.className = "answer-body";
    body.appendChild(renderAnswerMarkdown(content, sources || []));
    msg.appendChild(body);

    if (sources && sources.length) {
      const sourceDiv = document.createElement("div");
      sourceDiv.className = "answer-sources";
      sourceDiv.innerHTML = "<strong>参考来源：</strong>";
      sources.forEach((source) => {
        const badge = document.createElement("span");
        badge.className = "source-item";
        badge.textContent = `[${source.source_index}] 《${source.textbook_title}》${source.chapter_title}${formatCitationLocation(source)} · 相关度 ${formatPercent(source.score)}`;
        badge.title = `${source.excerpt}\n向量：${formatPercent(source.vector_score)}，关键词：${formatPercent(source.keyword_score)}`;
        badge.addEventListener("click", () => {
          selectBook(source.textbook_id);
        });
        sourceDiv.appendChild(badge);
      });
      msg.appendChild(sourceDiv);
    }
  } else {
    msg.textContent = content;
  }

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatCitationLocation(source) {
  if (source.page && source.page_end && source.page !== source.page_end) return ` 第${source.page}-${source.page_end}页`;
  if (source.page) return ` 第${source.page}页`;
  if (source.chunk_start && source.chunk_end && source.chunk_start !== source.chunk_end) return ` 片段${source.chunk_start}-${source.chunk_end}`;
  if (source.chunk_start) return ` 片段${source.chunk_start}`;
  return "";
}

function renderAnswerMarkdown(content, sources = []) {
  const fragment = document.createDocumentFragment();
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const maxSourceIndex = getMaxSourceIndex(sources);
  let paragraph = [];
  let activeList = null;
  let sectionNumber = 0;

  const closeList = () => {
    activeList = null;
  };

  const flushParagraph = () => {
    const text = paragraph.join("<br>").trim();
    paragraph = [];
    if (!text) return;
    const p = document.createElement("p");
    p.innerHTML = renderInlineMarkdown(text, maxSourceIndex);
    fragment.appendChild(p);
  };

  const appendListItem = (type, text, value = null) => {
    if (!activeList || activeList.tagName.toLowerCase() !== type) {
      flushParagraph();
      const list = document.createElement(type);
      activeList = list;
      fragment.appendChild(list);
    }
    const item = document.createElement("li");
    if (type === "ol" && value) item.value = value;
    item.innerHTML = renderInlineMarkdown(text, maxSourceIndex);
    activeList.appendChild(item);
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      return;
    }

    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph();
      closeList();
      fragment.appendChild(document.createElement("hr"));
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = Math.min(headingMatch[1].length + 2, 5);
      const heading = document.createElement(`h${level}`);
      heading.innerHTML = renderInlineMarkdown(headingMatch[2], maxSourceIndex);
      fragment.appendChild(heading);
      return;
    }

    const orderedHeadingMatch = trimmed.match(/^\d+[.)]\s+(\*\*.+?\*\*\s*[:：]?)$/);
    if (orderedHeadingMatch) {
      flushParagraph();
      closeList();
      sectionNumber += 1;
      const heading = document.createElement("h4");
      heading.innerHTML = `${sectionNumber}. ${renderInlineMarkdown(orderedHeadingMatch[1], maxSourceIndex)}`;
      fragment.appendChild(heading);
      return;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      appendListItem("ul", unorderedMatch[1]);
      return;
    }

    const orderedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (orderedMatch) {
      appendListItem("ol", orderedMatch[2], Number(orderedMatch[1]));
      return;
    }

    closeList();
    paragraph.push(trimmed);
  });

  flushParagraph();
  return fragment;
}

function getMaxSourceIndex(sources) {
  return sources.reduce((maxIndex, source) => Math.max(maxIndex, Number(source.source_index) || 0), 0);
}

function renderInlineMarkdown(text, maxSourceIndex = 0) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(\d+)\]/g, (match, index) => {
      const sourceIndex = Number(index);
      if (sourceIndex < 1 || sourceIndex > maxSourceIndex) return match;
      return `<span class="source-ref">[${sourceIndex}]</span>`;
    });
}

async function loadRagStatus() {
  try {
    const response = await fetch("/api/rag/status");
    if (!response.ok) return;
    const status = await response.json();
    const indexedCount = Object.values(status.indexed_textbooks || {}).filter(Boolean).length;
    ragStatus.textContent = indexedCount ? `${indexedCount} 本已索引` : "未索引";
    ragStatus.className = `status-pill ${indexedCount ? "" : "muted"}`;
  } catch {
    // Silently ignore
  }
}

boot();
