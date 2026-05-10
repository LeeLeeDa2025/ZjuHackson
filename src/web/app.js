const SOURCE_COLORS = ["#12715d", "#3267a8", "#b76e00", "#7b6ab5", "#b42318", "#4f7f2a", "#a1447a"];
const RELATION_ORDER = ["prerequisite", "parallel", "contains", "applies_to"];

const state = {
  textbooks: [],
  activeBook: null,
  activeChapterId: null,
  graph: null,
  graphPositions: new Map(),
  graphLayoutKey: "",
  selectedNodeId: null,
  searchQuery: "",
  view: { scale: 1, x: 0, y: 0 },
  pointer: null,
  uploadItems: [],
  buildSteps: [],
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
const graphStats = document.querySelector("#graphStats");
const graphSearch = document.querySelector("#graphSearch");
const graphLegend = document.querySelector("#graphLegend");
const resetViewButton = document.querySelector("#resetViewButton");
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
});
graphSearch.addEventListener("input", () => {
  state.searchQuery = graphSearch.value.trim().toLowerCase();
  renderKnowledgeGraph();
});
resetViewButton.addEventListener("click", () => {
  state.view = { scale: 1, x: 0, y: 0 };
  renderKnowledgeGraph();
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
  await Promise.all([loadModelScopeConfig(), loadTextbooks()]);
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
  const response = await fetch("/api/knowledge-graph");
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

  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  state.uploadItems = files.map((file) => ({ name: file.name, size: file.size, progress: 0, status: "queued" }));
  renderUploadProgress();
  setUploading(true);

  try {
    await uploadWithProgress(formData);
    state.uploadItems = state.uploadItems.map((item) => ({ ...item, progress: 100, status: "completed" }));
    renderUploadProgress();
    await loadTextbooks();
  } catch (error) {
    state.uploadItems = state.uploadItems.map((item) => ({ ...item, status: item.status === "completed" ? item.status : "failed" }));
    renderUploadProgress();
    alert(error.message || "上传失败");
  } finally {
    setUploading(false);
    fileInput.value = "";
  }
}

function uploadWithProgress(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/textbooks/upload");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      state.uploadItems = state.uploadItems.map((item) => ({
        ...item,
        progress,
        status: progress >= 100 ? "processing" : "uploading",
      }));
      renderUploadProgress();
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText || "{}"));
      else reject(new Error(xhr.responseText || "上传失败"));
    });
    xhr.addEventListener("error", () => reject(new Error("上传失败")));
    xhr.send(formData);
  });
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
  uploadProgressSummary.textContent = hasFailed ? "上传失败" : allDone ? "100%" : `${average}%`;
  uploadProgressSummary.className = `status-pill ${hasFailed ? "failed" : allDone ? "" : "parsing"}`;
  uploadProgressList.innerHTML = state.uploadItems
    .map(
      (item) => `
        <div class="progress-row">
          <div class="progress-row-meta">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${uploadStatusText(item.status)} · ${formatSize(item.size)}</span>
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
      builtGraphs.push(await postBuildGraph(target));
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

async function postBuildGraph(book) {
  const response = await fetch(`/api/textbooks/${encodeURIComponent(book.textbook_id)}/knowledge-graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_chapters: Math.min(book.chapter_count || 1, 20),
      force: true,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || `构建失败：${book.title || book.filename}`);
  return data;
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
      (step) => `
        <div class="build-step ${step.status}">
          <i></i>
          <div>
            <strong>${escapeHtml(step.label)}</strong>
            <span>${escapeHtml(step.detail)}</span>
          </div>
        </div>
      `,
    )
    .join("");
}

function updateBuildStep(id, status, detail) {
  state.buildSteps = state.buildSteps.map((step) => (step.id === id ? { ...step, status, detail: detail || step.detail } : step));
  renderBuildProgress(state.buildSteps);
}

function setUploading(isUploading) {
  parseStatus.textContent = isUploading ? "解析中" : state.activeBook ? "已完成" : "待解析";
  parseStatus.className = `status-pill ${isUploading ? "parsing" : state.activeBook ? "" : "muted"}`;
}

function setGraphBusy(isBusy) {
  graphButton.disabled = isBusy || !state.textbooks.length;
  graphScopeSelect.disabled = isBusy || !state.textbooks.length;
  if (isBusy) {
    graphStatus.textContent = "生成中";
    graphStatus.className = "status-pill parsing";
  }
}

function renderKnowledgeGraph() {
  graphSvg.innerHTML = "";
  renderLegend();
  if (!state.graph || !state.graph.nodes.length) {
    graphStatus.textContent = "未生成";
    graphStatus.className = "status-pill muted";
    graphStats.textContent = "选择构建范围后点击生成。";
    renderNodeDetail(null);
    return;
  }

  ensureGraphPositions();
  graphStatus.textContent = "可交互";
  graphStatus.className = "status-pill";
  graphStats.textContent = `${state.graph.nodes.length} 个知识点 · ${state.graph.edges.length} 条关系 · ${state.graph.textbook_count} 本教材来源`;
  drawGraph(state.graph);
  renderNodeDetail(state.graph.nodes.find((node) => node.id === state.selectedNodeId) || null);
}

function drawGraph(graph) {
  const width = 1280;
  const height = 760;
  const visibleNodes = graph.nodes.slice(0, 320);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const query = state.searchQuery;

  graphSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graphSvg.appendChild(svgElement("rect", { width, height, class: "graph-background" }));
  const viewport = svgElement("g", {
    class: "graph-viewport",
    transform: `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`,
  });
  graphSvg.appendChild(viewport);

  graph.edges.forEach((edge) => {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return;
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
      }),
    );
  });

  visibleNodes.forEach((node) => {
    const pos = state.graphPositions.get(node.id);
    const matches = query && searchableText(node).includes(query);
    const dimmed = query && !matches;
    const selected = state.selectedNodeId === node.id;
    const radius = nodeRadius(node);
    const group = svgElement("g", {
      class: `graph-node ${selected ? "selected" : ""} ${matches ? "matched" : ""} ${dimmed ? "dimmed" : ""}`,
      transform: `translate(${pos.x} ${pos.y})`,
      "data-node-id": node.id,
      tabindex: "0",
      role: "button",
    });
    group.appendChild(svgElement("circle", { r: radius + 16, class: "node-hit-area" }));
    group.appendChild(svgElement("circle", { r: radius, fill: sourceColor(node), "fill-opacity": nodeOpacity(node) }));
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
      const point = svgPoint(event);
      state.pointer = { mode: "node", nodeId: node.id, start: point, origin: { ...pos }, moved: false };
      graphSvg.setPointerCapture(event.pointerId);
    });
    viewport.appendChild(group);
  });
}

function ensureGraphPositions() {
  if (!state.graph) return;
  const layoutKey = state.graph.nodes.map((node) => `${node.id}:${node.name}:${node.textbook_ids?.join(",")}`).join("|");
  if (state.graphLayoutKey !== layoutKey) {
    state.graphPositions = new Map();
    state.graphLayoutKey = layoutKey;
    state.view = { scale: 1, x: 0, y: 0 };
  }

  const { width, height } = graphCanvasSize(state.graph.nodes);
  const groups = groupNodesBySource(state.graph.nodes.slice(0, 320));
  const groupGap = 80;
  const totalGap = groupGap * Math.max(groups.length - 1, 0);
  const groupWidth = (width - 160 - totalGap) / Math.max(groups.length, 1);

  groups.forEach((group, groupIndex) => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(group.nodes.length * 1.35)));
    const rows = Math.max(1, Math.ceil(group.nodes.length / cols));
    const spacingX = Math.max(112, Math.min(170, groupWidth / Math.max(cols, 1)));
    const spacingY = Math.max(92, Math.min(132, (height - 170) / Math.max(rows, 1)));
    const groupLeft = 80 + groupIndex * (groupWidth + groupGap);
    const blockWidth = (cols - 1) * spacingX;
    const blockHeight = (rows - 1) * spacingY;
    const startX = groupLeft + groupWidth / 2 - blockWidth / 2;
    const startY = height / 2 - blockHeight / 2;

    group.nodes.forEach((node, index) => {
      if (state.graphPositions.has(node.id)) return;
      const col = index % cols;
      const row = Math.floor(index / cols);
      const stagger = row % 2 ? spacingX * 0.22 : 0;
      state.graphPositions.set(node.id, { x: startX + col * spacingX + stagger, y: startY + row * spacingY });
    });
  });
}

function graphCanvasSize(nodes) {
  const groups = groupNodesBySource(nodes.slice(0, 320));
  const largestGroup = Math.max(...groups.map((group) => group.nodes.length), 1);
  const cols = Math.max(1, Math.ceil(Math.sqrt(largestGroup * 1.35)));
  const rows = Math.max(1, Math.ceil(largestGroup / cols));
  return {
    width: Math.max(1280, groups.length * Math.max(620, cols * 128) + Math.max(groups.length - 1, 0) * 80),
    height: Math.max(760, rows * 112 + 180),
  };
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
    <span class="legend-item"><i class="edge-sample prerequisite"></i>前置依赖</span>
    <span class="legend-item"><i class="edge-sample parallel"></i>并列关系</span>
    <span class="legend-item"><i class="edge-sample contains"></i>包含关系</span>
    <span class="legend-item"><i class="edge-sample applies_to"></i>应用关系</span>
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
  graphLegend.append(sourceGroup, relationGroup, frequencyGroup);
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
          <span>${escapeHtml(source.chapter || "未知章节")} · ${source.page ? `第 ${source.page} 页` : "无页码"}</span>
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
      sources: [{ textbook_id: graph.textbook_id, textbook_title: graph.title, chapter: node.chapter, page: node.page, definition: node.definition, source_excerpt: node.source_excerpt, node_id: node.id }],
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
  const nodeElement = event.target.closest?.(".graph-node");
  if (!nodeElement) return;
  event.stopPropagation();
  selectGraphNode(nodeElement.dataset.nodeId);
}

function onGraphWheel(event) {
  event.preventDefault();
  const oldScale = state.view.scale;
  const nextScale = clamp(oldScale * (event.deltaY > 0 ? 0.9 : 1.1), 0.45, 2.8);
  const rect = graphSvg.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  state.view.x = x - ((x - state.view.x) / oldScale) * nextScale;
  state.view.y = y - ((y - state.view.y) / oldScale) * nextScale;
  state.view.scale = nextScale;
  renderKnowledgeGraph();
}

function onGraphPointerDown(event) {
  if (event.target.closest?.(".graph-node")) return;
  state.pointer = { mode: "pan", startClient: { x: event.clientX, y: event.clientY }, origin: { x: state.view.x, y: state.view.y } };
  graphSvg.setPointerCapture(event.pointerId);
}

function onGraphPointerMove(event) {
  if (!state.pointer) return;
  if (state.pointer.mode === "pan") {
    state.view.x = state.pointer.origin.x + event.clientX - state.pointer.startClient.x;
    state.view.y = state.pointer.origin.y + event.clientY - state.pointer.startClient.y;
    renderKnowledgeGraph();
    return;
  }
  if (state.pointer.mode === "node") {
    const point = svgPoint(event);
    const dx = (point.x - state.pointer.start.x) / state.view.scale;
    const dy = (point.y - state.pointer.start.y) / state.view.scale;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.pointer.moved = true;
    state.graphPositions.set(state.pointer.nodeId, { x: state.pointer.origin.x + dx, y: state.pointer.origin.y + dy });
    renderKnowledgeGraph();
  }
}

function endGraphPointer() {
  if (state.pointer?.mode === "node" && !state.pointer.moved) selectGraphNode(state.pointer.nodeId);
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

boot();
