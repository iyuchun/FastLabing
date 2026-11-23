'use strict';

// ===================== 状态 =====================
let projectId = localStorage.getItem('anno_projectId') || null;
let projectName = '';       // 用户自定义项目名（可为空）
let projectFolder = '';     // 当前项目的帧目录（绝对路径）
let meta = null;            // { count, width, height, fps, files, thumbs }
let annotations = {};       // { "<frameNo>": [ {id,x,y,w,h}, ... ] }
let currentFrame = 1;
let selectedIndex = -1;
let undoStack = [];
let stickyCheckedIds = [];  // 跨帧 / 跨列表重建保留的勾选 ID（跟踪任务的选择）
const hiddenIds = new Set();  // 按 ID 隐藏，所有帧同步生效；仅前端显示，不影响保存 / 导出
const overwriteIds = new Set();  // 勾选「覆盖」的 ID，跟踪结束后自动清空

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const img = new Image();

// ===================== 元素 =====================
const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $('fileInput'), btnImport: $('btnImport'), fpsSelect: $('fpsSelect'),
  btnExtract: $('btnExtract'), categoryName: $('categoryName'), btnExport: $('btnExport'),
  btnUndo: $('btnUndo'), status: $('status'),
  idMode: $('idMode'), trackCount: $('trackCount'), trackFill: $('trackFill'),
  btnTrack: $('btnTrack'), trackStatus: $('trackStatus'),
  modelMode: $('modelMode'), trackPrecision: $('trackPrecision'), precisionRow: $('precisionRow'),
  trackModelBadge: $('trackModelBadge'), trackHint: $('trackHint'),
  canvasEmpty: $('canvasEmpty'),
  btnPrev: $('btnPrev'), btnNext: $('btnNext'), frameIndex: $('frameIndex'), frameCountLabel: $('frameCountLabel'),
  boxList: $('boxList'), boxSelectAll: $('boxSelectAll'), btnDeleteChecked: $('btnDeleteChecked'),
  btnToggleAllVisible: $('btnToggleAllVisible'), selectedPanel: $('selectedPanel'), selectedId: $('selectedId'),
  btnApplyId: $('btnApplyId'), btnDeleteSelected: $('btnDeleteSelected'),
  thumbStrip: $('thumbStrip'), modal: $('modal'), modalText: $('modalText'),
  modalLink: $('modalLink'), modalClose: $('modalClose'),
  btnManage: $('btnManage'), manageModal: $('manageModal'), manageClose: $('manageClose'),
  tabFrame: $('tabFrame'), tabIds: $('tabIds'),
  manageFramePane: $('manageFramePane'), manageIdsPane: $('manageIdsPane'),
  manageFrameNo: $('manageFrameNo'),
  manageFrameBody: $('manageFrameBody'), manageIdsBody: $('manageIdsBody'),
  frameAll: $('frameAll'), selNewId: $('selNewId'),
  selRenameBtn: $('selRenameBtn'), selDeleteBtn: $('selDeleteBtn'),
  scopeMode: $('scopeMode'), scopeRangeWrap: $('scopeRangeWrap'),
  scopeFrom: $('scopeFrom'), scopeTo: $('scopeTo'), scopeReplace: $('scopeReplace'),
  manageMsg: $('manageMsg'),
  addId: $('addId'), addX: $('addX'), addY: $('addY'), addW: $('addW'), addH: $('addH'),
  addBoxBtn: $('addBoxBtn'), clearFrameBtn: $('clearFrameBtn'),
  // 新版 UI 展示元素
  saveStateWrap: $('saveStateWrap'), saveState: $('saveState'),
  stageTitle: $('stageTitle'), stageSub: $('stageSub'),
  crumbTitle: $('crumbTitle'), crumbSub: $('crumbSub'),
  stepImport: $('stepImport'), stepExport: $('stepExport'),
  metaFrames: $('metaFrames'), metaFps: $('metaFps'), metaSize: $('metaSize'), metaAnnotated: $('metaAnnotated'),
  hudFrame: $('hudFrame'), hudTotal: $('hudTotal'),
  frameBigNo: $('frameBigNo'), frameBigTotal: $('frameBigTotal'), timecode: $('timecode'),
  inspectorFrame: $('inspectorFrame'), inspectorTotal: $('inspectorTotal'),
  frameBadge: $('frameBadge'), filmNote: $('filmNote'),
  annotatedCount: $('annotatedCount'),
  datasetPct: $('datasetPct'), datasetBar: $('datasetBar'),
  datasetDone: $('datasetDone'), datasetRest: $('datasetRest'),
  scrub: $('scrub'), scrubFill: $('scrubFill'), scrubHandle: $('scrubHandle'),
  statusSize: $('statusSize'), cursorXY: $('cursorXY'), statusProject: $('statusProject'),
  statusFolder: $('statusFolder'), statusFolderText: $('statusFolderText'),
  btnPrevFrame: $('btnPrevFrame'), btnNextFrame: $('btnNextFrame'),
  trackMinus: $('trackMinus'), trackPlus: $('trackPlus'), trackProgress: $('trackProgress'),
  gpuPanel: $('gpuPanel'), gpuBadge: $('gpuBadge'), gpuName: $('gpuName'),
  gpuUtil: $('gpuUtil'), gpuMem: $('gpuMem'), gpuTemp: $('gpuTemp'), gpuBar: $('gpuBar'),
  btnProjects: $('btnProjects'), projectModal: $('projectModal'), projectClose: $('projectClose'),
  projectNewBtn: $('projectNewBtn'), projectList: $('projectList'), projectSearch: $('projectSearch')
};

// ===================== 工具函数 =====================
function setStatus(msg) { el.status.textContent = msg || ''; }

function pad(n, w) { return String(Math.max(0, n | 0)).padStart(w || 4, '0'); }

function frameToTimecode(n) {
  const fps = (meta && meta.fps) || 5;
  const totalSec = Math.max(0, n - 1) / fps;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.floor((totalSec - Math.floor(totalSec)) * fps);
  return [h, m, s, f].map((v) => String(v).padStart(2, '0')).join(':');
}

function updateChrome() {
  const total = meta ? meta.count : 0;
  const ids = Object.keys(annotations);
  let doneFrames = 0;
  for (const k of ids) if ((annotations[k] || []).length) doneFrames++;

  el.frameBigNo.textContent = pad(currentFrame);
  el.frameBigTotal.textContent = total;
  el.inspectorFrame.textContent = currentFrame;
  el.inspectorTotal.textContent = total;
  el.hudFrame.textContent = pad(currentFrame);
  el.hudTotal.textContent = pad(total);
  el.timecode.textContent = frameToTimecode(currentFrame);
  el.frameCountLabel.textContent = '/ ' + total;
  el.frameBadge.textContent = peekBoxes(currentFrame).length + ' 个对象';
  el.filmNote.textContent = total + ' 帧';
  el.annotatedCount.textContent = doneFrames;
  el.metaFrames.textContent = total + ' 帧';
  el.metaFps.textContent = ((meta && meta.fps) || '—') + ' fps';
  el.metaSize.textContent = meta ? meta.width + ' × ' + meta.height : '—';
  el.metaAnnotated.textContent = '已标注 ' + doneFrames + ' 帧';
  el.statusSize.textContent = meta ? meta.width + ' × ' + meta.height : '0 × 0';
  el.statusProject.textContent = projectId ? '项目 ' + projectId : '未加载项目';
  updateFolderUI();
  el.crumbTitle.textContent = projectId ? (projectName || '标注项目') : '未导入';
  el.crumbSub.textContent = projectId ? (projectName ? projectId : '本地标注项目') : '本地标注项目';
  el.stageSub.textContent = projectId ? (projectName || projectId) : '本地项目';

  const pct = total ? Math.min(100, Math.round((doneFrames / total) * 100)) : 0;
  el.datasetPct.textContent = pct + '%';
  el.datasetBar.style.width = pct + '%';
  el.datasetDone.textContent = '已完成 ' + doneFrames + ' 帧';
  el.datasetRest.textContent = '剩余 ' + Math.max(0, total - doneFrames) + ' 帧';

  const pos = total > 1 ? ((currentFrame - 1) / (total - 1)) * 100 : 0;
  el.scrubFill.style.width = pos + '%';
  el.scrubHandle.style.left = pos + '%';
  el.scrub.setAttribute('aria-valuemax', String(total || 1));
  el.scrub.setAttribute('aria-valuenow', String(currentFrame));

  el.stepImport.classList.toggle('done', !!meta);
  el.stepExport.classList.toggle('done', !el.btnExport.disabled);
}

function setSaveState(saving) {
  if (!el.saveStateWrap) return;
  el.saveStateWrap.classList.toggle('is-saving', !!saving);
  el.saveState.textContent = saving ? '保存中…' : '已保存';
}

// 底部状态栏常驻显示当前项目目录，点击直接在资源管理器中打开
function updateFolderUI() {
  if (!el.statusFolder) return;
  el.statusFolder.disabled = !projectFolder;
  el.statusFolderText.textContent = projectFolder || '未加载项目目录';
  el.statusFolder.title = projectFolder ? '在资源管理器中打开：' + projectFolder : '';
}

el.statusFolder.addEventListener('click', async () => {
  if (!projectId || !projectFolder) return;
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/open-folder', { method: 'POST' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || '打开失败');
    }
    setStatus('已在资源管理器中打开项目目录');
  } catch (e) {
    setStatus(friendlyError('打开项目目录', e));
  }
});

function friendlyError(action, err) {
  if (err && (err.message === 'Failed to fetch' || err.name === 'TypeError')) {
    return '无法连接到服务。请确认已双击「一键启动.bat」且黑色命令窗口保持打开，然后刷新本页面。';
  }
  return action + '失败：' + (err && err.message ? err.message : err);
}

async function checkServer() {
  const st = document.getElementById('serverStatus');
  if (!st) return;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) { st.textContent = '● 服务运行中'; st.className = 'server-status on'; }
    else { st.textContent = '● 服务异常'; st.className = 'server-status off'; }
  } catch (e) {
    st.textContent = '● 服务未连接'; st.className = 'server-status off';
  }
}

function peekBoxes(n) { return annotations[String(n)] || []; }
function getBoxes(n) {
  const k = String(n);
  if (!annotations[k]) annotations[k] = [];
  return annotations[k];
}

function collectIds() {
  const s = new Set();
  for (const k in annotations) {
    for (const b of annotations[k]) if (b && b.id != null) s.add(Number(b.id));
  }
  return Array.from(s).sort((a, b) => a - b);
}

function nextId() {
  const ids = collectIds();
  return ids.length ? Math.max(...ids) + 1 : 1;
}

// 每个 ID 固定一种颜色：画布框、标签、右侧检查器保持一致
const ID_COLORS = [
  '#ff453a', '#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f',
  '#40c8e0', '#a78bfa', '#ffd60a', '#5e5ce6', '#ff6482', '#63e6be'
];

function colorForId(id) {
  const n = Number(id);
  const i = (Number.isFinite(n) && n > 0 ? n - 1 : 0) % ID_COLORS.length;
  return ID_COLORS[i];
}

// 根据底色亮度选择标签文字颜色（黑或白）
function textColorOn(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 145 ? '#000' : '#fff';
}

// 新建框 ID 模式：auto = 最大 ID + 1；prev = 沿用上一帧最后一个框的 ID
let idMode = 'auto';

function getNewBoxId() {
  if (idMode === 'prev') {
    const prev = peekBoxes(currentFrame - 1);
    if (prev.length) return Number(prev[prev.length - 1].id);
  }
  return nextId();
}

function refreshIdModeUI() {
  for (const btn of el.idMode.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.mode === idMode);
  }
}

function snapshot() {
  undoStack.push(JSON.stringify(annotations));
  if (undoStack.length > 200) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return;
  annotations = JSON.parse(undoStack.pop());
  selectedIndex = -1;
  refreshAll();
  save();
}

// ===================== 绘制 =====================
function draw() {
  if (!meta) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0);

  const boxes = peekBoxes(currentFrame);
  boxes.forEach((b, i) => {
    if (hiddenIds.has(Number(b.id))) return;
    const sel = i === selectedIndex;
    const color = colorForId(b.id);

    // 选中框加白色外描边，颜色仍保持该 ID 的专属色
    if (sel) {
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }

    ctx.lineWidth = sel ? 3 : 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '22';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    const text = 'ID ' + b.id;
    ctx.font = '14px sans-serif';
    const tw = ctx.measureText(text).width;
    const ly = b.y - 20 < 0 ? b.y + 2 : b.y - 20;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, ly, tw + 8, 18);
    ctx.fillStyle = textColorOn(color);
    ctx.fillText(text, b.x + 4, ly + 13);
  });

  if (selectedIndex >= 0) {
    const b = peekBoxes(currentFrame)[selectedIndex];
    if (b) drawHandles(b, colorForId(b.id));
  }
}

function handlePoints(b) {
  return [
    { x: b.x, y: b.y }, { x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h / 2 }, { x: b.x + b.w, y: b.y + b.h },
    { x: b.x + b.w / 2, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y + b.h / 2 }
  ];
}

function drawHandles(b, color) {
  const pts = handlePoints(b);
  ctx.fillStyle = color || '#00e676';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  pts.forEach((p) => {
    ctx.fillRect(p.x - 6, p.y - 6, 12, 12);
    ctx.strokeRect(p.x - 6, p.y - 6, 12, 12);
  });
}

function drawPreview() {
  if (!drag) return;
  const x = Math.min(drag.startX, drag.curX), y = Math.min(drag.startY, drag.curY);
  const w = Math.abs(drag.curX - drag.startX), h = Math.abs(drag.curY - drag.startY);
  ctx.lineWidth = 2; ctx.strokeStyle = '#00e676'; ctx.fillStyle = 'rgba(0,230,118,0.15)';
  ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
}

// ===================== 命中检测 =====================
function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function hitHandle(b, p) {
  const pts = handlePoints(b);
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(p.x - pts[i].x) <= 15 && Math.abs(p.y - pts[i].y) <= 15) return i;
  }
  return -1;
}

function hitBox(p) {
  const boxes = peekBoxes(currentFrame);
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return i;
  }
  return -1;
}

// ===================== 鼠标交互 =====================
let drag = null;

canvas.addEventListener('mousedown', (e) => {
  if (!meta || e.button !== 0) return;
  const p = toCanvas(e);
  const boxes = peekBoxes(currentFrame);

  if (selectedIndex >= 0 && boxes[selectedIndex]) {
    const h = hitHandle(boxes[selectedIndex], p);
    if (h >= 0) {
      drag = { mode: 'resize', handle: h, orig: { ...boxes[selectedIndex] }, moved: false };
      return;
    }
  }

  const hit = hitBox(p);
  if (hit >= 0) {
    selectedIndex = hit;
    drag = { mode: 'move', orig: { ...boxes[hit] }, startX: p.x, startY: p.y, moved: false };
    refreshBoxList(); refreshSelectedPanel(); draw();
    return;
  }

  selectedIndex = -1;
  drag = { mode: 'draw', startX: p.x, startY: p.y, curX: p.x, curY: p.y };
  refreshBoxList(); refreshSelectedPanel(); draw();
});

canvas.addEventListener('mousemove', (e) => {
  if (!drag) { updateCursor(e); return; }
  const p = toCanvas(e);
  if (drag.mode === 'draw') {
    drag.curX = p.x; drag.curY = p.y;
    draw(); drawPreview();
  } else if (drag.mode === 'move') {
    if (!drag.moved) { snapshot(); drag.moved = true; }
    const b = peekBoxes(currentFrame)[selectedIndex];
    if (!b) return;
    b.x = drag.orig.x + (p.x - drag.startX);
    b.y = drag.orig.y + (p.y - drag.startY);
    draw();
  } else if (drag.mode === 'resize') {
    if (!drag.moved) { snapshot(); drag.moved = true; }
    const b = peekBoxes(currentFrame)[selectedIndex];
    if (!b) return;
    resizeBox(b, drag.orig, drag.handle, p);
    draw();
  }
});

canvas.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.mode === 'draw') {
    const x = Math.min(drag.startX, drag.curX), y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX), h = Math.abs(drag.curY - drag.startY);
    if (w >= 3 && h >= 3) {
      snapshot();
      const box = { id: getNewBoxId(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      getBoxes(currentFrame).push(box);
      selectedIndex = peekBoxes(currentFrame).length - 1;
      refreshAll(); save();
    }
  } else if (drag.mode === 'move' || drag.mode === 'resize') {
    if (drag.moved) {
      const b = peekBoxes(currentFrame)[selectedIndex];
      if (b) normalizeBox(b);
      refreshAll(); save();
    } else {
      refreshBoxList(); refreshSelectedPanel(); draw();
    }
  }
  drag = null;
  draw();
});

canvas.addEventListener('mouseleave', () => {
  if (!drag) canvas.style.cursor = 'crosshair';
  el.cursorXY.textContent = 'x —  y —';
});

canvas.addEventListener('mousemove', (e) => {
  if (!meta) { el.cursorXY.textContent = 'x —  y —'; return; }
  const p = toCanvas(e);
  el.cursorXY.textContent = 'x ' + Math.round(p.x) + '  y ' + Math.round(p.y);
});

function resizeBox(b, orig, handle, p) {
  let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
  if (handle === 0) { x1 = p.x; y1 = p.y; }
  else if (handle === 1) { y1 = p.y; }
  else if (handle === 2) { x2 = p.x; y1 = p.y; }
  else if (handle === 3) { x2 = p.x; }
  else if (handle === 4) { x2 = p.x; y2 = p.y; }
  else if (handle === 5) { y2 = p.y; }
  else if (handle === 6) { x1 = p.x; y2 = p.y; }
  else if (handle === 7) { x1 = p.x; }
  b.x = Math.min(x1, x2); b.y = Math.min(y1, y2);
  b.w = Math.abs(x2 - x1); b.h = Math.abs(y2 - y1);
}

function normalizeBox(b) {
  const W = meta.width || 1, H = meta.height || 1;
  b.x = Math.max(0, Math.min(Math.round(b.x), W - 1));
  b.y = Math.max(0, Math.min(Math.round(b.y), H - 1));
  b.w = Math.max(1, Math.min(Math.round(b.w), W - b.x));
  b.h = Math.max(1, Math.min(Math.round(b.h), H - b.y));
  b.id = Number(b.id) || nextId();
}

function updateCursor(e) {
  if (!meta) return;
  const p = toCanvas(e);
  const boxes = peekBoxes(currentFrame);
  if (selectedIndex >= 0 && boxes[selectedIndex] && hitHandle(boxes[selectedIndex], p) >= 0) {
    canvas.style.cursor = 'nwse-resize';
  } else if (hitBox(p) >= 0) {
    canvas.style.cursor = 'move';
  } else {
    canvas.style.cursor = 'crosshair';
  }
}

// ===================== 界面刷新 =====================
function refreshIdSelect() {
  refreshIdModeUI();
}

function checkedBoxIndices() {
  return Array.from(el.boxList.querySelectorAll('input.boxchk:checked'))
    .map((c) => Number(c.dataset.i))
    .sort((a, b) => a - b);
}

function checkedBoxes() {
  const boxes = peekBoxes(currentFrame);
  return checkedBoxIndices().map((i) => boxes[i]).filter(Boolean);
}

// 跟踪结束后按 ID 恢复勾选状态（列表重建后使用）
function applyStickyChecks() {
  if (!stickyCheckedIds.length) return;
  const want = new Set(stickyCheckedIds.map(Number));
  const boxes = peekBoxes(currentFrame);
  el.boxList.querySelectorAll('input.boxchk').forEach((c) => {
    const b = boxes[Number(c.dataset.i)];
    c.checked = !!(b && want.has(Number(b.id)));
  });
}

function syncStickyChecks() {
  stickyCheckedIds = Array.from(new Set(checkedBoxes().map((b) => Number(b.id))));
}

function updateCheckedUI() {
  const total = peekBoxes(currentFrame).length;
  const count = checkedBoxIndices().length;
  el.boxSelectAll.checked = total > 0 && count === total;
  el.boxSelectAll.indeterminate = count > 0 && count < total;
  el.boxSelectAll.disabled = total === 0;
  el.btnDeleteChecked.disabled = count === 0;
  el.btnDeleteChecked.textContent = count ? `删除选中 (${count})` : '删除选中';
}

function refreshBoxList() {
  const boxes = peekBoxes(currentFrame);
  if (!boxes.length) {
    el.boxList.innerHTML = '<div class="muted">本帧暂无标注框</div>';
    updateCheckedUI();
    updateVisibilityUI();
    return;
  }
  el.boxList.innerHTML = '';
  boxes.forEach((b, i) => {
    const d = document.createElement('div');
    const hidden = hiddenIds.has(Number(b.id));
    d.className = 'boxitem' + (i === selectedIndex ? ' active' : '') + (hidden ? ' is-hidden' : '');
    const color = colorForId(b.id);
    d.innerHTML =
      '<label class="boxchk-wrap" title="勾选后可批量跟踪 / 删除">' +
      `<input type="checkbox" class="boxchk" data-i="${i}"></label>` +
      `<span class="bid-wrap"><i class="swatch" style="background:${color}"></i>` +
      `<span class="bid" style="color:${color}">ID ${b.id}</span></span>` +
      `<span class="bxy">(${Math.round(b.x)},${Math.round(b.y)}) ${Math.round(b.w)}×${Math.round(b.h)}</span>` +
      `<button class="eyebtn${hidden ? ' off' : ''}" type="button" data-i="${i}" ` +
      `title="${hidden ? '显示此 ID（所有帧）' : '隐藏此 ID（所有帧）'}" ` +
      `aria-label="${hidden ? '显示此 ID（所有帧）' : '隐藏此 ID（所有帧）'}">` +
      `<svg class="ic" aria-hidden="true"><use href="#i-${hidden ? 'eye-off' : 'eye'}"></use></svg></button>` +
      `<label class="ovrchk-wrap" title="勾选后跟踪时覆盖后续同 ID 的旧框">` +
      `<input type="checkbox" class="ovrchk" data-id="${b.id}"${overwriteIds.has(Number(b.id)) ? ' checked' : ''}>覆盖</label>`;
    d.addEventListener('click', (e) => {
      if (e.target.closest('.boxchk-wrap') || e.target.closest('.eyebtn') || e.target.closest('.ovrchk-wrap')) return;
      selectedIndex = i;
      refreshBoxList(); refreshSelectedPanel(); draw();
    });
    d.querySelector('.eyebtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleIdVisibility(b.id);
      refreshBoxList();
      draw();
    });
    el.boxList.appendChild(d);
  });
  applyStickyChecks();
  updateCheckedUI();
  updateVisibilityUI();
}

function toggleIdVisibility(id) {
  const key = Number(id);
  if (hiddenIds.has(key)) hiddenIds.delete(key);
  else hiddenIds.add(key);
}

function clearOverwriteChecks() {
  overwriteIds.clear();
  el.boxList.querySelectorAll('input.ovrchk').forEach((c) => { c.checked = false; });
}

function updateVisibilityUI() {
  if (!el.btnToggleAllVisible) return;
  const boxes = peekBoxes(currentFrame);
  const ids = Array.from(new Set(boxes.map((b) => Number(b.id))));
  const allHidden = ids.length > 0 && ids.every((id) => hiddenIds.has(id));
  el.btnToggleAllVisible.disabled = ids.length === 0;
  el.btnToggleAllVisible.innerHTML =
    '<svg class="ic" aria-hidden="true"><use href="#i-' + (allHidden ? 'eye' : 'eye-off') + '"></use></svg>' +
    (allHidden ? '全部显示' : '全部隐藏');
}

function refreshSelectedPanel() {
  const b = selectedIndex >= 0 ? peekBoxes(currentFrame)[selectedIndex] : null;
  el.selectedPanel.hidden = !b;
  if (b) el.selectedId.value = b.id;
}

function refreshAll() {
  refreshIdSelect();
  refreshBoxList();
  refreshSelectedPanel();
  renderManage();
  updateChrome();
  draw();
}

// ===================== 当前帧勾选（批量跟踪 / 删除） =====================
el.boxList.addEventListener('change', (e) => {
  if (e.target.classList && e.target.classList.contains('boxchk')) {
    syncStickyChecks();
    updateCheckedUI();
  } else if (e.target.classList && e.target.classList.contains('ovrchk')) {
    const id = Number(e.target.dataset.id);
    if (e.target.checked) overwriteIds.add(id);
    else overwriteIds.delete(id);
  }
});

el.boxSelectAll.addEventListener('change', () => {
  const on = el.boxSelectAll.checked;
  el.boxList.querySelectorAll('input.boxchk').forEach((c) => { c.checked = on; });
  syncStickyChecks();
  updateCheckedUI();
});

// 当前帧全部显示 / 全部隐藏（按 ID 对所有帧生效）
el.btnToggleAllVisible.addEventListener('click', () => {
  const boxes = peekBoxes(currentFrame);
  if (!boxes.length) return;
  const ids = Array.from(new Set(boxes.map((b) => Number(b.id))));
  const allHidden = ids.every((id) => hiddenIds.has(id));
  for (const id of ids) {
    if (allHidden) hiddenIds.delete(id);
    else hiddenIds.add(id);
  }
  refreshBoxList();
  draw();
});

el.btnDeleteChecked.addEventListener('click', () => {
  const idx = checkedBoxIndices();
  if (!idx.length) return;
  snapshot();
  const arr = getBoxes(currentFrame);
  for (let k = idx.length - 1; k >= 0; k--) arr.splice(idx[k], 1);
  selectedIndex = -1;
  refreshAll();
  save();
  setStatus(`已删除当前帧 ${idx.length} 个标注框`);
});

// ===================== 帧导航 =====================
function goToFrame(n) {
  if (!meta) return;
  n = Math.max(1, Math.min(meta.count, n | 0));
  currentFrame = n;
  selectedIndex = -1;
  if (projectId) localStorage.setItem('anno_frame_' + projectId, String(n));
  el.frameIndex.value = n;
  loadFrame();
  refreshIdSelect();
  refreshBoxList();
  refreshSelectedPanel();
  updateChrome();
  highlightThumb();
}

function loadFrame() {
  if (!meta) return;
  el.canvasEmpty.style.display = 'none';
  img.onload = () => {
    if (!meta) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    draw();
  };
  img.src = '/frames/' + projectId + '/' + meta.files[currentFrame - 1];
}

function rebuildThumbs() {
  el.thumbStrip.innerHTML = '';
  if (!meta) return;
  const list = (meta.thumbs && meta.thumbs.length === meta.count) ? meta.thumbs : meta.files;
  for (let i = 0; i < meta.count; i++) {
    const im = document.createElement('img');
    im.src = '/frames/' + projectId + '/' + list[i];
    im.loading = 'lazy';
    im.dataset.n = i + 1;
    im.title = '第 ' + (i + 1) + ' 帧';
    im.addEventListener('click', () => goToFrame(i + 1));
    el.thumbStrip.appendChild(im);
  }
  highlightThumb();
}

function highlightThumb() {
  const imgs = el.thumbStrip.children;
  let active = null;
  for (let i = 0; i < imgs.length; i++) {
    const on = Number(imgs[i].dataset.n) === currentFrame;
    imgs[i].classList.toggle('active', on);
    if (on) active = imgs[i];
  }
  // 当前帧缩略图固定在中间，缩略图条左右滚动
  if (active) {
    requestAnimationFrame(() => {
      const left = active.offsetLeft - (el.thumbStrip.clientWidth - active.clientWidth) / 2;
      el.thumbStrip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    });
  }
}

// 滚轮在缩略图条上横向滚动
el.thumbStrip.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  el.thumbStrip.scrollLeft += e.deltaY;
}, { passive: false });

// ===================== 持久化 =====================
let saveTimer = null;
function save() {
  if (!projectId) return;
  if (autoRunning) return;  // AI 自动打标运行中：禁止把旧标注回写服务端
  clearTimeout(saveTimer);
  setSaveState(true);
  saveTimer = setTimeout(doSave, 400);
}
function doSave() {
  if (!projectId) return;
  return fetch('/api/project/' + projectId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      categoryName: el.categoryName.value.trim() || 'object',
      annotations
    })
  }).then((r) => { if (!r.ok) throw new Error('save failed'); setSaveState(false); })
    .catch(() => setSaveState(false));
}

// ===================== 业务动作 =====================
el.btnImport.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  setStatus('正在上传视频...');
  const fd = new FormData();
  fd.append('video', f);
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '上传失败');
    projectId = data.projectId;
    projectName = '';
    localStorage.setItem('anno_projectId', projectId);
    annotations = {}; meta = null; currentFrame = 1; selectedIndex = -1;
    undoStack = [];
    el.btnExtract.disabled = false;
    el.btnExport.disabled = true;
    el.thumbStrip.innerHTML = '';
    el.canvasEmpty.style.display = 'flex';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStatus('上传成功，请选择 FPS 并点击「分帧」');
    updateChrome();
    resetAutoForProject();
  } catch (err) {
    alert(friendlyError('上传', err));
    setStatus('');
  }
  e.target.value = '';
});

el.btnExtract.addEventListener('click', async () => {
  if (!projectId) { alert('请先导入视频'); return; }
  const fps = el.fpsSelect.value;
  if (meta && meta.count) {
    const ok = confirm(
      `项目「${projectName || projectId}」已有 ${meta.count} 帧。\n\n` +
      '重新分帧会清空并覆盖全部帧图片；已有标注不会删除，但帧序号可能错位。\n' +
      '确定重新分帧？'
    );
    if (!ok) return;
  }
  setStatus('正在分帧，请稍候...');
  el.btnExtract.disabled = true;
  try {
    const r = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, fps })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '分帧失败');
    meta = data;
    currentFrame = 1; selectedIndex = -1;
    stickyCheckedIds = [];
    hiddenIds.clear();
    overwriteIds.clear();
    localStorage.setItem('anno_frame_' + projectId, '1');
    el.frameCountLabel.textContent = '/ ' + meta.count;
    el.frameIndex.value = 1;
    el.btnExport.disabled = false;
    markLastProject(projectId);
    rebuildThumbs();
    refreshAll();
    loadFrame();
    updateAutoUI();
    setStatus(`分帧完成：共 ${meta.count} 帧（${meta.width}×${meta.height}）`);
  } catch (err) {
    alert(friendlyError('分帧', err));
    setStatus('');
  } finally {
    el.btnExtract.disabled = false;
  }
});

el.btnExport.addEventListener('click', async () => {
  if (!projectId || !meta) { alert('请先导入视频并分帧'); return; }
  const catName = el.categoryName.value.trim() || 'object';
  setStatus('正在导出并加密打包...');
  try {
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, categoryName: catName })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '导出失败');
    el.modalText.innerHTML =
      `视频项目：<b>${projectId}</b><br>` +
      `类别：<b>${data.categoryName}</b><br>` +
      `标注框总数：<b>${data.totalBoxes}</b>`;
    el.modalLink.href = data.downloadUrl;
    el.modalLink.download = data.filename;
    el.modal.hidden = false;
    el.stepExport.classList.add('done');
    setStatus('导出成功');
  } catch (err) {
    alert(friendlyError('导出', err));
    setStatus('');
  }
});

el.modalClose.addEventListener('click', () => { el.modal.hidden = true; });

el.btnPrev.addEventListener('click', () => goToFrame(currentFrame - 1));
el.btnNext.addEventListener('click', () => goToFrame(currentFrame + 1));
el.btnPrevFrame.addEventListener('click', () => goToFrame(currentFrame - 1));
el.btnNextFrame.addEventListener('click', () => goToFrame(currentFrame + 1));
el.frameIndex.addEventListener('change', () => {
  const n = parseInt(el.frameIndex.value, 10);
  if (n) goToFrame(n);
});

// 进度条：点击/拖动跳到对应帧
let scrubDrag = false;
function scrubTo(e) {
  if (!meta) return;
  const rect = el.scrub.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  goToFrame(1 + Math.round(pct * (meta.count - 1)));
}
el.scrub.addEventListener('pointerdown', (e) => {
  scrubDrag = true;
  el.scrub.setPointerCapture(e.pointerId);
  scrubTo(e);
});
el.scrub.addEventListener('pointermove', (e) => { if (scrubDrag) scrubTo(e); });
el.scrub.addEventListener('pointerup', (e) => {
  scrubDrag = false;
  try { el.scrub.releasePointerCapture(e.pointerId); } catch (_) {}
});
el.scrub.addEventListener('pointercancel', () => { scrubDrag = false; });

// 跟踪帧数步进
function bumpTrackCount(delta) {
  const v = Math.max(1, Math.min(300, (parseInt(el.trackCount.value, 10) || 30) + delta));
  el.trackCount.value = v;
}
el.trackMinus.addEventListener('click', () => bumpTrackCount(-1));
el.trackPlus.addEventListener('click', () => bumpTrackCount(1));

// ===================== 跟踪模型选择（SAM3 / SAM2.1） =====================
let trackModel = localStorage.getItem('anno_trackModel') === 'sam2' ? 'sam2' : 'sam3';
function refreshTrackModelUI() {
  el.modelMode.querySelectorAll('button[data-model]').forEach((b) => {
    b.classList.toggle('active', b.dataset.model === trackModel);
  });
  el.precisionRow.hidden = trackModel !== 'sam3';
  el.trackModelBadge.textContent = trackModel === 'sam3' ? 'SAM 3' : 'SAM 2.1';
  el.trackHint.textContent = trackModel === 'sam3'
    ? 'SAM 3 精度更高，8G 显存建议选「快速」；已有同 ID 的帧自动跳过，勾选行尾「覆盖」可重跟覆盖。'
    : 'SAM 2.1 更快、显存约 1GB；已有同 ID 的帧自动跳过，勾选行尾「覆盖」可重跟覆盖。';
}
el.modelMode.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-model]');
  if (!btn) return;
  trackModel = btn.dataset.model;
  localStorage.setItem('anno_trackModel', trackModel);
  refreshTrackModelUI();
});
refreshTrackModelUI();

el.btnUndo.addEventListener('click', undo);

el.btnApplyId.addEventListener('click', () => {
  const b = selectedIndex >= 0 ? peekBoxes(currentFrame)[selectedIndex] : null;
  if (!b) return;
  const n = parseInt(el.selectedId.value, 10);
  if (!n || n < 1) { alert('ID 必须是正整数'); return; }
  snapshot();
  b.id = n;
  refreshAll(); save();
});
el.selectedId.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.btnApplyId.click(); }
});

el.btnDeleteSelected.addEventListener('click', () => {
  if (selectedIndex < 0) return;
  snapshot();
  getBoxes(currentFrame).splice(selectedIndex, 1);
  selectedIndex = -1;
  refreshAll(); save();
});

// ===================== 智能跟踪 =====================
el.idMode.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  idMode = btn.dataset.mode;
  refreshIdModeUI();
});

function setTrackStatus(msg) { el.trackStatus.textContent = msg || ''; }
function setTrackProgress(pct) { el.trackProgress.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ===================== 智能跟踪（只补缺口，不覆盖已有标注） =====================
function boxWithId(frame, id) {
  const target = Number(id);
  return peekBoxes(frame).find((b) => b && Number(b.id) === target) || null;
}

// 在 [start, end] 内找出该 ID 缺框的连续段
function findGapsForId(id, start, end) {
  const gaps = [];
  let from = null;
  for (let f = start; f <= end; f++) {
    if (!boxWithId(f, id)) {
      if (from === null) from = f;
    } else if (from !== null) {
      gaps.push({ from, to: f - 1 });
      from = null;
    }
  }
  if (from !== null) gaps.push({ from, to: end });
  return gaps;
}

// 自动连续性阈值：不合格时返回原因
function boxInvalidReason(prev, next) {
  if (!next) return '没有跟踪结果';
  if (next.w < 8 || next.h < 8) return '跟踪框过小';
  const W = (meta && meta.width) || 0;
  const H = (meta && meta.height) || 0;
  if (W && H && (next.x < 0 || next.y < 0 || next.x + next.w > W || next.y + next.h > H)) {
    return '跟踪框超出画面';
  }
  const pcx = prev.x + prev.w / 2;
  const pcy = prev.y + prev.h / 2;
  const ncx = next.x + next.w / 2;
  const ncy = next.y + next.h / 2;
  if (Math.hypot(ncx - pcx, ncy - pcy) > 1.5 * Math.max(prev.w, prev.h)) return '中心位移过大';
  const rw = next.w / prev.w;
  const rh = next.h / prev.h;
  if (rw < 0.5 || rw > 2 || rh < 0.5 || rh > 2) return '尺寸突变';
  const ar = (next.w / next.h) / (prev.w / prev.h);
  if (ar < 0.5 || ar > 2) return '宽高比突变';
  return '';
}

async function pollTrackJob(jobId, prefix, onProgress) {
  while (true) {
    await sleep(500);
    const r = await fetch('/api/track/' + jobId, { cache: 'no-store' });
    if (!r.ok) throw new Error('任务已中断（服务可能已重启）');
    const job = await r.json();
    if (!job || !job.status) throw new Error('任务状态丢失（服务可能已重启）');
    if (job.status === 'running') {
      const p = job.total ? ` ${job.progress}/${job.total}` : '';
      setTrackStatus(prefix + (job.message || '跟踪中…') + p);
      if (job.total && onProgress) onProgress(job.progress / job.total);
      continue;
    }
    if (job.status === 'error') throw new Error(job.error || '跟踪失败');
    return job.result || [];
  }
}

async function trackSegment(startFrame, count, box, id, prefix, onProgress) {
  const r = await fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId, startFrame, count,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      id,
      model: trackModel,
      precision: el.trackPrecision.value,
      fillMissing: el.trackFill.checked
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '提交失败');
  return pollTrackJob(data.jobId, prefix, onProgress);
}

el.btnTrack.addEventListener('click', async () => {
  if (!projectId || !meta) { alert('请先导入视频并分帧'); return; }

  // 优先使用勾选的框（可多选）；没有勾选时退回当前点选的框
  let targets = checkedBoxes();
  const hadChecked = targets.length > 0;
  if (!targets.length) {
    const active = selectedIndex >= 0 ? peekBoxes(currentFrame)[selectedIndex] : null;
    if (active) targets = [active];
  }
  if (!targets.length) { alert('请先勾选（或点选）至少一个框，再点「用选中框跟踪」'); return; }

  // 记录本次任务的勾选，之后的列表重建 / 切帧继续保留
  stickyCheckedIds = hadChecked
    ? Array.from(new Set(targets.map((b) => Number(b.id))))
    : [];

  // 读取「覆盖」勾选：勾选的 ID 会重跟并替换后续旧框
  const overwriteSnapshot = new Set(overwriteIds);

  const scanCount = Math.max(1, Math.min(300, parseInt(el.trackCount.value, 10) || 30));
  const startFrame = currentFrame;
  const endFrame = Math.min(meta.count, startFrame + scanCount - 1);

  // 每个 ID 独立规划：普通模式只补缺口；覆盖模式跟踪当前帧之后的整段
  const plans = [];
  const seen = new Set();
  for (const target of targets) {
    const id = Number(target.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const isOverwrite = overwriteSnapshot.has(id);
    const gaps = isOverwrite
      ? (endFrame > startFrame ? [{ from: startFrame + 1, to: endFrame }] : [])
      : findGapsForId(id, startFrame, endFrame);
    plans.push({ id, overwrite: isOverwrite, gaps });
  }

  const targetFrames = plans.reduce(
    (sum, p) => sum + p.gaps.reduce((s, g) => s + (g.to - g.from + 1), 0), 0
  );
  if (!targetFrames) {
    clearOverwriteChecks();
    setTrackProgress(100);
    if (endFrame <= startFrame) {
      setTrackStatus('当前已是跟踪范围的最后一帧，没有可跟踪的帧');
    } else {
      setTrackStatus(`范围内 ${scanCount} 帧都已有 ${plans.map((p) => 'ID ' + p.id).join('、')} 的框，跳过跟踪`);
    }
    return;
  }

  // 统计「已有标注被跳过」的帧数（覆盖模式不跳过）
  let skippedFrames = 0;
  for (const p of plans) {
    if (p.overwrite) continue;
    skippedFrames += (endFrame - startFrame + 1) -
      p.gaps.reduce((s, g) => s + (g.to - g.from + 1), 0);
  }
  let processedFrames = 0;
  let writtenFrames = 0;
  let overwrittenFrames = 0;
  let snapshotted = false;
  let stopped = null;

  el.btnTrack.disabled = true;
  el.btnDeleteChecked.disabled = true;
  el.boxSelectAll.disabled = true;
  setTrackProgress(3);

  outer:
  for (const plan of plans) {
    for (let gi = 0; gi < plan.gaps.length; gi++) {
      const gap = plan.gaps[gi];
      const anchorFrame = gap.from - 1;
      const seed = boxWithId(anchorFrame, plan.id);
      if (!seed) {
        stopped = { id: plan.id, frame: gap.from, reason: '缺少可用的种子框' };
        break outer;
      }

      const segLen = gap.to - gap.from + 1;
      const segCount = gap.to - anchorFrame + 1;
      const prefix = plan.overwrite
        ? `ID ${plan.id} · 第 ${gap.from}–${gap.to} 帧（覆盖）· `
        : `ID ${plan.id} · 第 ${gap.from}–${gap.to} 帧（${gi + 1}/${plan.gaps.length}）· `;

      try {
        const boxes = await trackSegment(anchorFrame, segCount, seed, plan.id, prefix, (frac) => {
          const done = processedFrames + segLen * Math.min(1, Math.max(0, frac));
          setTrackProgress(3 + 92 * (done / targetFrames));
        });
        const byFrame = new Map(boxes.map((t) => [Number(t.frame), t]));
        let prev = { x: seed.x, y: seed.y, w: seed.w, h: seed.h };
        let failure = null;

        for (let f = gap.from; f <= gap.to; f++) {
          let t = byFrame.get(f);
          if (!t) {
            if (!el.trackFill.checked) { failure = { frame: f, reason: '模型未返回结果' }; break; }
            t = { x: prev.x, y: prev.y, w: prev.w, h: prev.h };
          }
          const reason = boxInvalidReason(prev, t);
          if (reason) { failure = { frame: f, reason }; break; }

          const nb = { id: plan.id, x: t.x, y: t.y, w: t.w, h: t.h };
          normalizeBox(nb);
          const arr = getBoxes(f);
          if (plan.overwrite) {
            if (!snapshotted) { snapshot(); snapshotted = true; }
            const had = arr.some((b) => Number(b.id) === plan.id);
            for (let i = arr.length - 1; i >= 0; i--) {
              if (Number(arr[i].id) === plan.id) arr.splice(i, 1);
            }
            arr.push(nb);
            writtenFrames++;
            if (had) overwrittenFrames++;
          } else if (!arr.some((b) => Number(b.id) === plan.id)) {
            if (!snapshotted) { snapshot(); snapshotted = true; }
            arr.push(nb);
            writtenFrames++;
          }
          prev = { x: nb.x, y: nb.y, w: nb.w, h: nb.h };
        }

        processedFrames += segLen;
        save();  // 每段完成立即落盘，崩溃也不丢已写入的框
        setTrackProgress(3 + 92 * (processedFrames / targetFrames));

        if (failure) {
          stopped = { id: plan.id, frame: failure.frame, reason: failure.reason };
          break outer;
        }
      } catch (err) {
        processedFrames += segLen;
        stopped = { id: plan.id, frame: gap.from, reason: err.message || String(err) };
        break outer;
      }
    }
  }

  clearOverwriteChecks();  // 覆盖勾选只作用于本次任务
  save();
  refreshAll();
  el.btnTrack.disabled = false;

  if (stopped) {
    setTrackProgress(0);
    // 跳到未完成帧的前一帧（最后一个成功写入/种子帧），方便直接接着补标
    const jumpFrame = Math.max(1, Math.min(meta.count, stopped.frame - 1));
    goToFrame(jumpFrame);
    setTrackStatus(
      `跟踪中断：ID ${stopped.id} 在第 ${stopped.frame} 帧中断（${stopped.reason}）；` +
      `已跳到第 ${jumpFrame} 帧`
    );
  } else {
    setTrackProgress(100);
    setTrackStatus(
      '跟踪完成：' +
      (skippedFrames ? `跳过 ${skippedFrames} 帧已有标注，` : '') +
      `写入 ${writtenFrames} 帧` +
      (overwrittenFrames ? `（覆盖 ${overwrittenFrames} 帧）` : '')
    );
  }
});

// ===================== 批量管理 =====================
let manageTab = 'frame';

el.btnManage.addEventListener('click', () => {
  el.manageModal.hidden = false;
  if (!el.scopeFrom.value) el.scopeFrom.value = 1;
  if (!el.scopeTo.value) el.scopeTo.value = meta ? meta.count : 1;
  el.scopeRangeWrap.hidden = el.scopeMode.value !== 'range';
  setManageMsg('');
  setManageTab('frame');
});
el.manageClose.addEventListener('click', () => { el.manageModal.hidden = true; });
el.manageModal.addEventListener('click', (e) => {
  if (e.target === el.manageModal) el.manageModal.hidden = true;
});
el.tabFrame.addEventListener('click', () => setManageTab('frame'));
el.tabIds.addEventListener('click', () => setManageTab('ids'));

function setManageTab(tab) {
  manageTab = tab;
  setManageMsg('');
  el.tabFrame.classList.toggle('active', tab === 'frame');
  el.tabIds.classList.toggle('active', tab === 'ids');
  el.manageFramePane.hidden = tab !== 'frame';
  el.manageIdsPane.hidden = tab !== 'ids';
  renderManage();
}

function setManageMsg(msg) { el.manageMsg.textContent = msg || ''; }

function renderManage() {
  if (el.manageModal.hidden) return;
  el.manageFrameNo.textContent = currentFrame;
  if (manageTab === 'frame') renderFrameTable();
  else renderIdsTable();
}

function selectedFrameIndices() {
  return Array.from(el.manageFrameBody.querySelectorAll('input.rowchk:checked'))
    .map((c) => Number(c.dataset.i))
    .sort((a, b) => a - b);
}

function renderFrameTable() {
  const boxes = peekBoxes(currentFrame);
  const prevChecked = new Set(selectedFrameIndices());
  el.manageFrameBody.innerHTML = '';
  if (!boxes.length) {
    el.manageFrameBody.innerHTML = '<tr><td colspan="7" class="muted">本帧暂无标注框</td></tr>';
    el.frameAll.checked = false;
  } else {
    boxes.forEach((b, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><input type="checkbox" class="rowchk" data-i="${i}" ${prevChecked.has(i) ? 'checked' : ''}></td>` +
        `<td><input type="number" min="1" data-i="${i}" data-k="id" value="${b.id}"></td>` +
        `<td><input type="number" data-i="${i}" data-k="x" value="${b.x}"></td>` +
        `<td><input type="number" data-i="${i}" data-k="y" value="${b.y}"></td>` +
        `<td><input type="number" data-i="${i}" data-k="w" value="${b.w}"></td>` +
        `<td><input type="number" data-i="${i}" data-k="h" value="${b.h}"></td>` +
        `<td><button class="btn small" data-act="locate" data-i="${i}">定位</button>` +
        `<button class="btn small danger" data-act="del" data-i="${i}">删除</button></td>`;
      el.manageFrameBody.appendChild(tr);
    });
    el.frameAll.checked = prevChecked.size > 0 && prevChecked.size >= boxes.length;
  }
  el.addId.value = nextId();
  el.addX.value = ''; el.addY.value = ''; el.addW.value = ''; el.addH.value = '';
}

el.frameAll.addEventListener('change', () => {
  el.manageFrameBody.querySelectorAll('input.rowchk').forEach((c) => {
    c.checked = el.frameAll.checked;
  });
});

el.manageFrameBody.addEventListener('change', (e) => {
  const inp = e.target;
  if (inp.tagName !== 'INPUT' || !inp.dataset.k) return;
  const i = Number(inp.dataset.i);
  const k = inp.dataset.k;
  const b = peekBoxes(currentFrame)[i];
  if (!b) return;
  const v = Number(inp.value);
  if (!Number.isFinite(v)) { renderFrameTable(); return; }
  snapshot();
  b[k] = k === 'id' ? Math.max(1, Math.round(v)) : Math.round(v);
  normalizeBox(b);
  refreshAll(); save();
});

el.manageFrameBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const b = peekBoxes(currentFrame)[i];
  if (!b) return;
  if (btn.dataset.act === 'locate') {
    selectedIndex = i;
    el.manageModal.hidden = true;
    refreshAll();
  } else if (btn.dataset.act === 'del') {
    snapshot();
    getBoxes(currentFrame).splice(i, 1);
    selectedIndex = -1;
    refreshAll(); save();
  }
});

el.selRenameBtn.addEventListener('click', () => {
  const idx = selectedFrameIndices();
  if (!idx.length) { alert('请先勾选要修改的框'); return; }
  const newId = parseInt(el.selNewId.value, 10);
  if (!newId || newId < 1) { alert('请输入目标 ID（正整数）'); el.selNewId.focus(); return; }
  snapshot();
  const boxes = getBoxes(currentFrame);
  for (const i of idx) if (boxes[i]) boxes[i].id = newId;
  refreshAll(); save();
  setManageMsg(`已把当前帧勾选的 ${idx.length} 个框改为 ID ${newId}`);
});

el.selDeleteBtn.addEventListener('click', () => {
  const idx = selectedFrameIndices();
  if (!idx.length) { alert('请先勾选要删除的框'); return; }
  if (!confirm(`确定删除当前帧勾选的 ${idx.length} 个框？`)) return;
  snapshot();
  const boxes = getBoxes(currentFrame);
  for (let k = idx.length - 1; k >= 0; k--) boxes.splice(idx[k], 1);
  selectedIndex = -1;
  refreshAll(); save();
  setManageMsg(`已删除当前帧勾选的 ${idx.length} 个框`);
});

el.addBoxBtn.addEventListener('click', () => {
  if (!meta) { alert('请先导入视频并分帧'); return; }
  const id = parseInt(el.addId.value, 10);
  const b = {
    id: id > 0 ? id : nextId(),
    x: Number(el.addX.value) || 0,
    y: Number(el.addY.value) || 0,
    w: Number(el.addW.value) || 0,
    h: Number(el.addH.value) || 0
  };
  if (b.w <= 0 || b.h <= 0) { alert('宽和高必须大于 0'); return; }
  snapshot();
  normalizeBox(b);
  getBoxes(currentFrame).push(b);
  selectedIndex = peekBoxes(currentFrame).length - 1;
  refreshAll(); save();
});

el.clearFrameBtn.addEventListener('click', () => {
  const boxes = peekBoxes(currentFrame);
  if (!boxes.length) return;
  if (!confirm(`确定清空第 ${currentFrame} 帧的所有框（共 ${boxes.length} 个）？`)) return;
  snapshot();
  annotations[String(currentFrame)] = [];
  selectedIndex = -1;
  refreshAll(); save();
});

// ---------- 按 ID 管理（支持范围） ----------
function getScope() {
  const mode = el.scopeMode.value;
  if (mode === 'current') return { mode, from: currentFrame, to: currentFrame };
  if (mode === 'range') {
    let a = parseInt(el.scopeFrom.value, 10) || 1;
    let b = parseInt(el.scopeTo.value, 10) || a;
    if (a > b) { const t = a; a = b; b = t; }
    if (meta) {
      a = Math.max(1, Math.min(a, meta.count));
      b = Math.max(1, Math.min(b, meta.count));
    }
    return { mode, from: a, to: b };
  }
  return { mode: 'all', from: 1, to: meta ? meta.count : Infinity };
}

function inScope(frame, scope) {
  return scope.mode === 'all' || (frame >= scope.from && frame <= scope.to);
}

function scopeLabel(scope) {
  if (scope.mode === 'all') return '全部帧';
  if (scope.mode === 'current') return `第 ${currentFrame} 帧`;
  return `第 ${scope.from}~${scope.to} 帧`;
}

el.scopeMode.addEventListener('change', () => {
  el.scopeRangeWrap.hidden = el.scopeMode.value !== 'range';
  if (el.scopeMode.value === 'range') {
    if (!el.scopeFrom.value) el.scopeFrom.value = 1;
    if (!el.scopeTo.value) el.scopeTo.value = meta ? meta.count : 1;
  }
  renderManage();
});
el.scopeFrom.addEventListener('change', renderManage);
el.scopeTo.addEventListener('change', renderManage);

function collectIdStats() {
  const map = new Map();  // id -> { count, frames:Set }
  for (const k in annotations) {
    const f = Number(k);
    for (const b of annotations[k]) {
      if (!b || b.id == null) continue;
      const id = Number(b.id);
      if (!map.has(id)) map.set(id, { count: 0, frames: new Set() });
      const s = map.get(id);
      s.count++;
      s.frames.add(f);
    }
  }
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
}

function countInScope(id, scope) {
  let n = 0;
  for (const k in annotations) {
    const f = Number(k);
    if (!inScope(f, scope)) continue;
    for (const b of annotations[k]) if (b && Number(b.id) === id) n++;
  }
  return n;
}

function renderIdsTable() {
  const rows = collectIdStats();
  const scope = getScope();
  el.manageIdsBody.innerHTML = '';
  if (!rows.length) {
    el.manageIdsBody.innerHTML = '<tr><td colspan="6" class="muted">暂无任何标注框</td></tr>';
    return;
  }
  for (const [id, s] of rows) {
    const frames = Array.from(s.frames).sort((a, b) => a - b);
    const range = frames.length === 1 ? String(frames[0]) : `${frames[0]} ~ ${frames[frames.length - 1]}`;
    const scoped = countInScope(id, scope);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="bid">ID ${id}</td><td>${s.count}</td><td>${range}（${frames.length} 帧）</td>` +
      `<td${scoped ? '' : ' class="muted"'}>${scoped}</td>` +
      `<td><input type="number" min="1" placeholder="新ID" style="width:62px" data-newid="${id}">` +
      `<button class="btn small" data-act="rename" data-id="${id}">改</button></td>` +
      `<td><button class="btn small" data-act="goto" data-id="${id}">跳转</button>` +
      `<button class="btn small danger" data-act="delid" data-id="${id}">删除</button></td>`;
    el.manageIdsBody.appendChild(tr);
  }
}

el.manageIdsBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const oldId = Number(btn.dataset.id);
  const scope = getScope();

  if (btn.dataset.act === 'goto') {
    let target = null;
    for (const k in annotations) {
      const f = Number(k);
      if (!inScope(f, scope)) continue;
      if (!annotations[k].some((b) => b && Number(b.id) === oldId)) continue;
      if (target === null || f < target) target = f;
    }
    if (target === null) { alert(`${scopeLabel(scope)}内没有 ID ${oldId} 的框`); return; }
    el.manageModal.hidden = true;
    goToFrame(target);
    return;
  }

  if (btn.dataset.act === 'rename') {
    const inp = btn.parentElement.querySelector('input[data-newid]');
    const newId = parseInt(inp.value, 10);
    if (!newId || newId < 1) { alert('请在「改ID」输入框填写目标 ID'); inp.focus(); return; }
    if (newId === oldId) { alert('新 ID 与原 ID 相同'); return; }

    const affected = [];
    const conflicts = [];
    for (const k in annotations) {
      const f = Number(k);
      if (!inScope(f, scope)) continue;
      const arr = annotations[k];
      if (!arr.some((b) => b && Number(b.id) === oldId)) continue;
      affected.push(f);
      if (arr.some((b) => b && Number(b.id) === newId)) conflicts.push(f);
    }
    if (!affected.length) { alert(`${scopeLabel(scope)}内没有 ID ${oldId} 的框`); return; }

    const replace = el.scopeReplace.checked;
    let tip = `把${scopeLabel(scope)}内 ID ${oldId} 的框（${affected.length} 帧）改为 ID ${newId}？`;
    if (conflicts.length) {
      tip += `\n其中 ${conflicts.length} 帧已存在 ID ${newId}，` +
        (replace ? '将替换这些框。' : '改完后两个框会并存（可勾选「替换」避免）。');
    }
    if (!confirm(tip)) return;

    snapshot();
    for (const f of affected) {
      const arr = annotations[String(f)];
      if (replace) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] && Number(arr[i].id) === newId) arr.splice(i, 1);
        }
      }
      for (const b of arr) if (b && Number(b.id) === oldId) b.id = newId;
    }
    refreshAll(); save();
    setManageMsg(`已把${scopeLabel(scope)}内 ${affected.length} 帧的 ID ${oldId} 改为 ID ${newId}`);
    return;
  }

  if (btn.dataset.act === 'delid') {
    const frames = [];
    let count = 0;
    for (const k in annotations) {
      const f = Number(k);
      if (!inScope(f, scope)) continue;
      const c = annotations[k].filter((b) => b && Number(b.id) === oldId).length;
      if (c) { frames.push(k); count += c; }
    }
    if (!count) { alert(`${scopeLabel(scope)}内没有 ID ${oldId} 的框`); return; }
    if (!confirm(`确定删除${scopeLabel(scope)}内 ID ${oldId} 的 ${count} 个框？`)) return;
    snapshot();
    for (const k of frames) {
      annotations[k] = annotations[k].filter((b) => !b || Number(b.id) !== oldId);
    }
    selectedIndex = -1;
    refreshAll(); save();
    setManageMsg(`已删除${scopeLabel(scope)}内 ID ${oldId} 的 ${count} 个框`);
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); }
  else if (k === 'arrowleft' || k === 'a') { e.preventDefault(); goToFrame(currentFrame - 1); }
  else if (k === 'arrowright' || k === 'd') { e.preventDefault(); goToFrame(currentFrame + 1); }
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); el.btnDeleteSelected.click(); }
});

// ===================== 项目管理 =====================
let lastProjectId = null;
let projectCache = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 通知服务端记录「上次项目」：换浏览器/换端口/重启服务后都能自动恢复
function markLastProject(pid) {
  lastProjectId = pid;
  fetch('/api/last-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: pid })
  }).catch(() => {});
}

// 载入任意项目：帧数据 + 标注 + 缩略图，整体重置界面状态
async function applyProject(pid, statusText, name) {
  const r = await fetch('/frames/' + encodeURIComponent(pid) + '/meta.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('项目帧数据不存在');
  const m = await r.json();

  let data = {};
  try {
    const pr = await fetch('/api/project/' + encodeURIComponent(pid), { cache: 'no-store' });
    if (pr.ok) data = await pr.json();
  } catch (_) {}

  meta = m;
  projectId = pid;
  projectName = name || '';
  annotations = data.annotations || {};
  projectFolder = data.folder || '';
  if (data.categoryName) el.categoryName.value = data.categoryName;
  stickyCheckedIds = [];
  hiddenIds.clear();
  overwriteIds.clear();

  // 恢复该项目的上次浏览帧，刷新页面 / 崩溃重开后回到中断位置
  const savedFrame = parseInt(localStorage.getItem('anno_frame_' + pid) || '1', 10);
  currentFrame = Math.max(1, Math.min(Number(meta.count) || 1, savedFrame || 1));
  selectedIndex = -1;
  undoStack = [];
  drag = null;
  localStorage.setItem('anno_projectId', pid);
  markLastProject(pid);

  el.frameCountLabel.textContent = '/ ' + meta.count;
  el.frameIndex.value = currentFrame;
  el.btnExtract.disabled = false;
  el.btnExport.disabled = false;
  setSaveState(false);
  resetAutoForProject();
  rebuildThumbs();
  refreshAll();
  loadFrame();
  setStatus(statusText || '已载入项目：' + pid);
  resumeAutoFromServer();
}

async function fetchProjects() {
  const r = await fetch('/api/projects', { cache: 'no-store' });
  if (!r.ok) throw new Error('无法读取项目列表');
  return r.json();
}

function makeProjectCard(p) {
  const pct = p.frames ? Math.min(100, Math.round((p.annotatedFrames / p.frames) * 100)) : 0;
  const card = document.createElement('div');
  card.className = 'project-card' + (p.id === projectId ? ' active' : '');
  card.dataset.pid = p.id;

  const thumb = p.thumb
    ? `<img class="pc-thumb" src="/frames/${encodeURIComponent(p.id)}/${p.thumb}" alt="" loading="lazy">`
    : '<span class="pc-thumb"></span>';

  const title = p.name
    ? `<span class="pc-name">${escapeHtml(p.name)}</span><span class="pc-id mono">${p.id}</span>`
    : `<span class="mono">${p.id}</span>`;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'pc-open';
  open.dataset.act = 'open';
  open.title = '切换到该项目';
  open.innerHTML =
    thumb +
    '<span class="pc-main">' +
      '<span class="pc-title">' + title +
        (p.id === projectId ? '<span class="badge blue">当前</span>' : '') +
        (p.id === lastProjectId && p.id !== projectId ? '<span class="badge">上次</span>' : '') +
      '</span>' +
      '<span class="pc-meta">' + p.frames + ' 帧 · ' + (p.fps || '—') + ' fps · ' +
        (p.width || '—') + '×' + (p.height || '—') + ' · 类别 ' + (p.categoryName || 'object') + '</span>' +
      '<span class="pc-bar"><i style="width:' + pct + '%"></i></span>' +
      '<span class="pc-sub">已标注 ' + p.annotatedFrames + '/' + p.frames + ' 帧（' + pct + '%）· 共 ' +
        p.totalBoxes + ' 个框 · ' + fmtTime(p.updatedAt) + '</span>' +
    '</span>';

  const actions = document.createElement('div');
  actions.className = 'pc-actions';
  actions.innerHTML =
    '<button class="btn small" type="button" data-act="folder" title="在资源管理器中打开项目文件夹">文件夹</button>' +
    '<button class="btn small" type="button" data-act="rename" title="修改项目名称">改名</button>' +
    '<button class="btn small danger" type="button" data-act="delete" title="删除项目及全部数据">删除</button>';

  card.appendChild(open);
  card.appendChild(actions);
  return card;
}

async function openProjects() {
  el.projectModal.hidden = false;
  el.projectList.innerHTML = '<div class="project-empty">正在读取项目…</div>';
  el.projectSearch.value = '';
  try {
    const data = await fetchProjects();
    lastProjectId = data.lastProjectId || lastProjectId;
    projectCache = (data.projects || []).map((p) => ({
      ...p,
      _search: ((p.name || '') + ' ' + p.id + ' ' + (p.categoryName || '')).toLowerCase()
    }));
    renderProjectCards();
  } catch (err) {
    el.projectList.innerHTML = '<div class="project-empty">读取失败：' + (err.message || err) + '</div>';
  }
}

function renderProjectCards() {
  const q = (el.projectSearch.value || '').trim().toLowerCase();
  const list = q ? projectCache.filter((p) => p._search.includes(q)) : projectCache;
  el.projectList.innerHTML = '';
  if (!projectCache.length) {
    el.projectList.innerHTML = '<div class="project-empty">还没有任何项目。点击「新建项目」导入视频并分帧。</div>';
    return;
  }
  if (!list.length) {
    el.projectList.innerHTML = '<div class="project-empty">没有匹配「' + escapeHtml(el.projectSearch.value.trim()) + '」的项目</div>';
    return;
  }
  for (const p of list) el.projectList.appendChild(makeProjectCard(p));
}

async function loadProject(p) {
  if (!p || p.id === projectId) { el.projectModal.hidden = true; return; }
  try {
    await applyProject(p.id, '已切换到：' + (p.name || p.id), p.name);
    el.projectModal.hidden = true;
  } catch (err) {
    alert('切换项目失败：' + (err.message || err));
  }
}

// 在资源管理器中打开该项目的帧文件夹
async function openProjectFolder(p) {
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(p.id) + '/open-folder', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '打开文件夹失败');
    setStatus('已在资源管理器打开：' + (data.path || p.id));
  } catch (err) {
    alert('打开文件夹失败：' + (err.message || err));
  }
}

async function renameProject(p) {
  const input = prompt('项目名称（留空则恢复显示项目 ID）', p.name || '');
  if (input === null) return;
  const name = input.trim().slice(0, 60);
  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(p.id) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '重命名失败');
    p.name = data.name || '';
    p._search = ((p.name || '') + ' ' + p.id + ' ' + (p.categoryName || '')).toLowerCase();
    if (p.id === projectId) {
      projectName = p.name;
      refreshAll();
    }
    renderProjectCards();
    setStatus('项目已重命名：' + (p.name || p.id));
  } catch (err) {
    alert('重命名失败：' + (err.message || err));
  }
}

async function deleteProject(p) {
  const label = p.name || p.id;
  const ok = confirm(
    `确定删除项目「${label}」？\n\n将永久删除：\n` +
    `· ${p.frames} 帧图片\n` +
    `· ${p.annotatedFrames} 帧标注（${p.totalBoxes} 个框）\n` +
    `· 上传的视频与导出文件\n\n此操作无法撤销。`
  );
  if (!ok) return;

  try {
    const r = await fetch('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '删除失败');

    projectCache = projectCache.filter((x) => x.id !== p.id);
    if (lastProjectId === p.id) lastProjectId = null;
    if (p.id === projectId) {
      const rest = projectCache.slice();
      if (rest.length) {
        await applyProject(rest[0].id, '已切换到：' + (rest[0].name || rest[0].id), rest[0].name);
      } else {
        resetToEmpty();
      }
    }
    renderProjectCards();
    setStatus('项目已删除：' + label);
  } catch (err) {
    alert('删除失败：' + (err.message || err));
  }
}

// 项目全部删除后回到空白状态
function resetToEmpty() {
  projectId = null;
  projectName = '';
  projectFolder = '';
  meta = null;
  annotations = {};
  stickyCheckedIds = [];
  hiddenIds.clear();
  overwriteIds.clear();
  currentFrame = 1;
  selectedIndex = -1;
  undoStack = [];
  drag = null;
  localStorage.removeItem('anno_projectId');
  el.thumbStrip.innerHTML = '';
  el.boxList.innerHTML = '';
  el.canvasEmpty.style.display = 'flex';
  el.frameCountLabel.textContent = '/ 0';
  el.frameIndex.value = 1;
  el.btnExtract.disabled = true;
  el.btnExport.disabled = true;
  el.selectedPanel.hidden = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  resetAutoForProject();
  refreshAll();
  setStatus('等待导入视频');
}

el.btnProjects.addEventListener('click', openProjects);
el.projectClose.addEventListener('click', () => { el.projectModal.hidden = true; });
el.projectModal.addEventListener('click', (e) => {
  if (e.target === el.projectModal) el.projectModal.hidden = true;
});
el.projectNewBtn.addEventListener('click', () => {
  el.projectModal.hidden = true;
  el.fileInput.click();
});
el.projectSearch.addEventListener('input', renderProjectCards);
el.projectList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.project-card');
  const p = projectCache.find((x) => x.id === (card && card.dataset.pid));
  if (!p) return;
  const act = btn.dataset.act;
  if (act === 'open') loadProject(p);
  else if (act === 'folder') openProjectFolder(p);
  else if (act === 'rename') renameProject(p);
  else if (act === 'delete') deleteProject(p);
});

// ===================== AI 自动打标 =====================
const autoEl = {
  panel: $('autoPanel'), btn: $('btnAuto'), hint: $('autoHint'), capBadge: $('autoCapBadge'),
  modal: $('autoModal'), close: $('autoClose'),
  params: $('autoParamsPane'), start: $('btnAutoStart'), closeParams: $('btnAutoCloseParams'),
  prompt: $('autoPrompt'), score: $('autoScore'), scoreVal: $('autoScoreVal'),
  minArea: $('autoMinArea'), mode: $('autoMode'), range: $('autoRange'), msg: $('autoMsg'),
  running: $('autoRunPane'), progress: $('autoProgress'), status: $('autoStatus'),
  progressText: $('autoProgressText'), found: $('autoFound'), runPrompt: $('autoRunPrompt'),
  cancel: $('btnAutoCancel'),
  result: $('autoResultPane'), resultTitle: $('autoResultTitle'), resultMsg: $('autoResultMsg'),
  resultStats: $('autoResultStats'), resFrames: $('autoResultFrames'),
  resBoxes: $('autoResultBoxes'), resObjects: $('autoResultObjects'),
  viewBtn: $('btnAutoView'), retry: $('btnAutoRetry')
};

const AUTO_HINT = 'SAM 3 文本提示自动检出并跟踪画面中所有人物，结果写入当前项目，完成后可直接人工微调。';
let autoCapability = null;   // { available, reason, backend }：页面加载时探测一次
let autoJobId = null;        // 正在轮询的任务；切项目时置空，避免旧任务回写新项目
let autoRunning = false;
let autoStartFrame = 1;      // 任务完成 / 取消后跳回的帧
let autoPollFails = 0;
let autoLastJob = null;

function updateAutoRangeLabel() {
  const opt = autoEl.range && autoEl.range.querySelector('option[value="current"]');
  if (opt) {
    opt.textContent = currentFrame > 1
      ? '从当前帧（第 ' + currentFrame + ' 帧）到结尾'
      : '从当前帧到结尾';
  }
}

function updateAutoUI() {
  if (!autoEl.btn) return;
  const capReady = !!(autoCapability && autoCapability.available);
  let title;
  if (!autoCapability) title = '正在检测自动打标环境…';
  else if (!capReady) title = autoCapability.reason || '未检测到可用的 SAM 3 自动打标环境';
  else if (!projectId) title = '请先导入视频并分帧';
  else if (!meta) title = '请先完成分帧';
  else if (autoRunning) title = 'AI 自动打标正在运行，点击查看进度';
  else title = '按提示词自动检出并跟踪目标';

  autoEl.btn.disabled = !(capReady && !!projectId && !!meta);
  autoEl.btn.title = title;
  if (autoEl.panel) autoEl.panel.classList.toggle('is-off', !capReady);
  if (autoEl.capBadge) {
    autoEl.capBadge.textContent = !autoCapability ? '检测中' : (capReady ? (autoRunning ? '运行中' : '可用') : '不可用');
    autoEl.capBadge.classList.toggle('blue', capReady);
    autoEl.capBadge.title = title;
  }
  if (autoEl.hint) {
    if (!autoCapability) {
      autoEl.hint.textContent = '正在检测自动打标运行环境…';
    } else if (!capReady) {
      autoEl.hint.textContent = '自动打标暂不可用：' + (autoCapability.reason || '缺少运行环境') +
        '。装好环境后刷新本页即可重新检测。';
    } else if (autoRunning) {
      autoEl.hint.textContent = 'AI 自动打标正在后台运行，点开按钮可查看进度或取消。';
    } else {
      autoEl.hint.textContent = AUTO_HINT;
    }
  }
}

async function loadAutoCapability() {
  try {
    const r = await fetch('/api/auto/capability', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    autoCapability = {
      available: !!(data && data.available),
      reason: (data && data.reason) || '',
      backend: (data && data.backend) || 'sam3'
    };
  } catch (err) {
    autoCapability = { available: false, reason: '后端自动打标接口未就绪（/api/auto/capability 不可用）', backend: 'sam3' };
  }
  updateAutoUI();
  resumeAutoFromServer();
}

// 刷新页面 / 重新打开项目后，若后端仍有本项目的自动打标任务在跑，则恢复进度轮询
async function resumeAutoFromServer() {
  if (autoRunning || autoJobId) return;   // 本页已在跟踪，避免重复轮询
  if (!projectId) return;
  const checkPid = projectId;
  let job = null;
  try {
    const r = await fetch('/api/auto/current', { cache: 'no-store' });
    if (!r.ok) return;                    // 旧后端没有该接口：静默跳过
    const data = await r.json();
    job = data && data.job;
  } catch (_) {
    return;
  }
  if (!job || !job.jobId) return;
  if (projectId !== checkPid || job.projectId !== projectId) return;  // 项目不匹配 / 请求期间已切项目
  if (autoRunning || autoJobId) return;

  if (job.status === 'running') {
    autoJobId = job.jobId;
    autoRunning = true;
    autoLastJob = job;
    autoStartFrame = Math.max(1, Number(job.startFrame) || 1);
    updateAutoUI();
    setStatus('已恢复 AI 自动打标任务，可在「AI 自动打标」中查看进度');
    pollAutoJob(job.jobId);
    return;
  }
  if (job.status === 'done') {
    // 静默同步一次结果；不弹窗、不跳帧、不打扰
    await reloadAnnotationsAfterAuto(0);
    updateAutoUI();
  }
  // error / cancelled 静默忽略
}

function setAutoView(view) {
  if (!autoEl.params) return;
  autoEl.params.hidden = view !== 'params';
  autoEl.running.hidden = view !== 'running';
  autoEl.result.hidden = view !== 'result';
  if (view === 'running' && autoEl.cancel) autoEl.cancel.disabled = false;
}

function setAutoMsg(text) {
  if (autoEl.msg) autoEl.msg.textContent = text || '';
}

function setAutoStatus(text) {
  if (autoEl.status) autoEl.status.textContent = text || '';
}

function setAutoProgress(pct) {
  if (autoEl.progress) autoEl.progress.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}

function setAutoProgressText(done, total) {
  if (autoEl.progressText) autoEl.progressText.textContent = (done || 0) + ' / ' + (total || 0) + ' 帧';
}

function openAutoModal() {
  if (!autoEl.modal || !projectId || !meta) return;
  setAutoMsg('');
  if (autoRunning) {
    if (autoLastJob) applyAutoJobProgress(autoLastJob);
    setAutoView('running');
  } else {
    setAutoView('params');
    updateAutoRangeLabel();
  }
  autoEl.modal.hidden = false;
}

function closeAutoModal() {
  if (!autoEl.modal) return;
  autoEl.modal.hidden = true;
  if (autoRunning) setStatus('AI 自动打标仍在后台运行，完成后会自动同步结果');
}

async function startAutoTask() {
  if (autoRunning) return;
  if (!projectId || !meta) { setAutoMsg('请先导入视频并分帧'); return; }
  if (!autoCapability || !autoCapability.available) {
    setAutoMsg('自动打标环境不可用：' + ((autoCapability && autoCapability.reason) || '未检测到 SAM 3 运行环境'));
    return;
  }

  const prompt = String(autoEl.prompt.value || '').trim();
  if (!prompt) {
    setAutoMsg('请先填写提示词（英文效果最好，例如 person / worker）');
    autoEl.prompt.focus();
    return;
  }
  const minScore = Math.max(0.1, Math.min(0.9, parseFloat(autoEl.score.value) || 0.5));
  const minArea = parseFloat(autoEl.minArea.value);
  if (!Number.isFinite(minArea) || minArea < 0.001 || minArea > 10) {
    setAutoMsg('最小框面积需在 0.001 ~ 10 之间（单位 %）');
    autoEl.minArea.focus();
    return;
  }
  const mode = ['replace', 'fill', 'append'].indexOf(autoEl.mode.value) >= 0 ? autoEl.mode.value : 'replace';
  const fromCurrent = autoEl.range.value === 'current';
  const startFrame = fromCurrent ? Math.max(1, Math.min(meta.count, currentFrame)) : 1;
  const count = fromCurrent ? Math.max(1, meta.count - startFrame + 1) : Math.max(1, meta.count);

  const submitPid = projectId;
  autoRunning = true;
  autoStartFrame = startFrame;
  autoLastJob = null;
  autoPollFails = 0;
  setAutoMsg('');
  setAutoView('running');
  setAutoProgress(0);
  setAutoStatus('正在提交任务…');
  setAutoProgressText(0, count);
  if (autoEl.found) autoEl.found.textContent = '0';
  if (autoEl.runPrompt) autoEl.runPrompt.textContent = prompt;
  updateAutoUI();

  // 先把本地未落盘的修改同步给服务端，避免自动打标基于旧标注运行
  try {
    clearTimeout(saveTimer);
    saveTimer = null;
    setSaveState(true);
    await doSave();
  } catch (_) {}
  if (!autoRunning || projectId !== submitPid) return;

  let resp = null;
  let data = null;
  try {
    resp = await fetch('/api/auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: submitPid, prompt, minScore, minArea, mode, startFrame, count
      })
    });
    data = await resp.json().catch(() => ({}));
  } catch (err) {
    autoRunning = false;
    setAutoView('params');
    setAutoMsg('无法连接自动打标服务：' + (err && err.message ? err.message : err));
    updateAutoUI();
    return;
  }
  if (!autoRunning || projectId !== submitPid) return;

  if (!resp.ok) {
    autoRunning = false;
    setAutoView('params');
    setAutoMsg((data && data.error) || ('提交失败（HTTP ' + resp.status + '）'));
    updateAutoUI();
    return;
  }
  if (!data || !data.jobId) {
    autoRunning = false;
    setAutoView('params');
    setAutoMsg('后端未返回任务 ID，请检查服务端 /api/auto 实现');
    updateAutoUI();
    return;
  }

  autoJobId = data.jobId;
  setAutoStatus('任务已提交，正在启动模型…');
  pollAutoJob(data.jobId);
}

function applyAutoJobProgress(job) {
  if (!job) return;
  autoLastJob = job;
  const total = Number(job.total) || 0;
  const done = Number(job.progress) || 0;
  setAutoProgress(total ? Math.min(99, (done / total) * 100) : 0);
  setAutoProgressText(done, total);
  if (typeof job.found === 'number' && autoEl.found) autoEl.found.textContent = String(job.found);
  setAutoStatus(job.message || '正在识别…');
}

async function pollAutoJob(jobId) {
  while (autoJobId === jobId) {
    await sleep(1000);
    if (autoJobId !== jobId) return;

    let job = null;
    try {
      const r = await fetch('/api/auto/' + encodeURIComponent(jobId), { cache: 'no-store' });
      if (autoJobId !== jobId) return;
      if (r.status === 404) {
        finishAutoTask('error', { error: '任务不存在或已丢失（服务可能已重启）' });
        return;
      }
      job = await r.json();
      if (!r.ok) throw new Error((job && job.error) || ('HTTP ' + r.status));
    } catch (err) {
      if (autoJobId !== jobId) return;
      autoPollFails++;
      if (autoPollFails >= 3) {
        finishAutoTask('error', { error: '无法获取任务进度：' + (err && err.message ? err.message : err) });
        return;
      }
      continue;
    }
    if (autoJobId !== jobId) return;
    autoPollFails = 0;
    if (!job || !job.status) {
      finishAutoTask('error', { error: '任务状态丢失（服务可能已重启）' });
      return;
    }
    if (job.status === 'done') { finishAutoTask('done', job); return; }
    if (job.status === 'error') { finishAutoTask('error', job); return; }
    if (job.status === 'cancelled') { finishAutoTask('cancelled', job); return; }
    applyAutoJobProgress(job);
  }
}

function autoNumText(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : '—';
}

function autoResultSummary(result) {
  if (!result) return '已完成';
  return '处理 ' + autoNumText(result.frameCount) + ' 帧 · 写入 ' +
    autoNumText(result.boxCount) + ' 个框 · 跟踪 ' + autoNumText(result.objectCount) + ' 个目标';
}

function showAutoResultDone(job) {
  const res = (job && job.result) || {};
  autoEl.resultTitle.textContent = '打标完成';
  autoEl.resultMsg.className = 'auto-msg ok';
  autoEl.resultMsg.textContent = '结果已写入当前项目，可直接在画布上人工微调。';
  autoEl.resultStats.hidden = false;
  autoEl.resFrames.textContent = autoNumText(res.frameCount);
  autoEl.resBoxes.textContent = autoNumText(res.boxCount);
  autoEl.resObjects.textContent = autoNumText(res.objectCount);
  autoEl.viewBtn.hidden = false;
  autoEl.viewBtn.textContent = '关闭并查看';
  autoEl.retry.hidden = false;
  autoEl.modal.hidden = false;
  setAutoView('result');
}

function showAutoResultIssue(kind, job) {
  const cancelled = kind === 'cancelled';
  autoEl.resultTitle.textContent = cancelled ? '已取消自动打标' : '自动打标失败';
  autoEl.resultMsg.className = cancelled ? 'auto-msg warn' : 'auto-msg';
  autoEl.resultMsg.textContent = cancelled
    ? '任务已取消，已处理的部分结果可能已写入项目，已同步最新项目数据。'
    : ((job && (job.error || job.message)) || '未知错误，请查看服务端命令窗口日志');
  autoEl.resultStats.hidden = true;
  autoEl.viewBtn.hidden = !cancelled;
  autoEl.viewBtn.textContent = '关闭并查看';
  autoEl.retry.hidden = false;
  autoEl.modal.hidden = false;
  setAutoView('result');
}

async function finishAutoTask(kind, job) {
  const jumpFrame = autoStartFrame;
  autoJobId = null;
  autoRunning = false;
  autoPollFails = 0;
  try {
    if (kind === 'done') {
      const total = Number(job && job.total) || Number(job && job.progress) || 0;
      setAutoProgress(100);
      setAutoStatus('打标完成，正在同步项目数据…');
      setAutoProgressText(total, total);
      if (job && typeof job.found === 'number' && autoEl.found) autoEl.found.textContent = String(job.found);
      await reloadAnnotationsAfterAuto(jumpFrame);
      showAutoResultDone(job);
      setStatus('AI 自动打标完成：' + autoResultSummary(job && job.result));
    } else if (kind === 'cancelled') {
      setAutoStatus('任务已取消');
      await reloadAnnotationsAfterAuto(jumpFrame);
      showAutoResultIssue('cancelled', job);
      setStatus('AI 自动打标已取消，已同步当前项目数据');
    } else {
      setAutoStatus('自动打标失败');
      showAutoResultIssue('error', job);
      setStatus('AI 自动打标失败：' + ((job && (job.error || job.message)) || '未知错误'));
    }
  } catch (err) {
    setStatus('AI 自动打标处理结果时出错：' + (err && err.message ? err.message : err));
  } finally {
    updateAutoUI();
  }
}

// 自动打标写盘后：丢弃本地待保存数据，从服务端重新拉取权威标注
async function reloadAnnotationsAfterAuto(jumpFrame) {
  const pid = projectId;
  if (!pid) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  setSaveState(false);
  try {
    const r = await fetch('/api/project/' + encodeURIComponent(pid), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (pid !== projectId) return;  // 拉取期间切换了项目，不能覆盖新项目数据
    annotations = (data && data.annotations) || {};
    if (data && data.categoryName) el.categoryName.value = data.categoryName;
    undoStack = [];
    stickyCheckedIds = [];
    hiddenIds.clear();
    overwriteIds.clear();
    selectedIndex = -1;
    setSaveState(false);
    refreshAll();
    if (meta && jumpFrame) goToFrame(Math.max(1, Math.min(Number(meta.count) || 1, jumpFrame)));
  } catch (err) {
    setStatus('自动打标完成，但刷新项目数据失败：' + (err && err.message ? err.message : err));
  }
}

async function cancelAutoTask() {
  const jobId = autoJobId;
  if (!jobId || !autoRunning) return;
  if (autoEl.cancel) autoEl.cancel.disabled = true;
  setAutoStatus('正在取消任务…');
  try {
    await fetch('/api/auto/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' });
  } catch (_) {}
  // 兜底：后端 5 秒内仍未返回 cancelled 状态时，本地停止等待并按取消处理
  setTimeout(() => {
    if (autoJobId === jobId && autoRunning) {
      finishAutoTask('cancelled', { status: 'cancelled', message: '已停止等待任务状态', result: null });
    }
  }, 5000);
}

// 切换 / 新建 / 删除项目时调用：丢弃旧任务轮询，避免结果串到新项目
function resetAutoForProject() {
  const oldJob = autoJobId;
  autoJobId = null;
  autoRunning = false;
  autoPollFails = 0;
  autoLastJob = null;
  autoStartFrame = 1;
  if (oldJob) {
    fetch('/api/auto/' + encodeURIComponent(oldJob) + '/cancel', { method: 'POST' }).catch(() => {});
  }
  if (autoEl.modal) {
    autoEl.modal.hidden = true;
    setAutoView('params');
  }
  setAutoMsg('');
  updateAutoUI();
}

if (autoEl.btn) autoEl.btn.addEventListener('click', openAutoModal);
if (autoEl.close) autoEl.close.addEventListener('click', closeAutoModal);
if (autoEl.closeParams) autoEl.closeParams.addEventListener('click', closeAutoModal);
if (autoEl.modal) {
  autoEl.modal.addEventListener('click', (e) => {
    if (e.target === autoEl.modal) closeAutoModal();
  });
}
if (autoEl.score) {
  autoEl.score.addEventListener('input', () => {
    if (autoEl.scoreVal) autoEl.scoreVal.textContent = Number(autoEl.score.value).toFixed(2);
  });
}
if (autoEl.start) autoEl.start.addEventListener('click', startAutoTask);
if (autoEl.cancel) autoEl.cancel.addEventListener('click', cancelAutoTask);
if (autoEl.viewBtn) autoEl.viewBtn.addEventListener('click', closeAutoModal);
if (autoEl.retry) {
  autoEl.retry.addEventListener('click', () => {
    setAutoView('params');
    setAutoMsg('');
    updateAutoRangeLabel();
  });
}

updateAutoRangeLabel();
updateAutoUI();
loadAutoCapability();

// ===================== 启动：自动恢复上次项目 =====================
async function tryResume() {
  let data = null;
  try { data = await fetchProjects(); } catch (_) {}
  const list = (data && data.projects) || [];
  lastProjectId = (data && data.lastProjectId) || null;

  // 优先服务端记录的上次项目，其次本机记住的项目，最后取最近修改的项目
  const candidates = [lastProjectId, localStorage.getItem('anno_projectId'), list[0] && list[0].id];
  for (const pid of candidates) {
    if (!pid) continue;
    const item = list.find((x) => x.id === pid);
    try {
      await applyProject(pid, '已载入上次项目：' + ((item && item.name) || pid), item && item.name);
      return;
    } catch (_) {}
  }
  setStatus('等待导入视频');
}

checkServer();
setInterval(checkServer, 5000);
tryResume();

// ===================== GPU 实时监控 =====================
async function pollGPU() {
  try {
    const r = await fetch('/api/gpu', { cache: 'no-store' });
    const data = await r.json();
    const g = data.gpu;
    if (!g) {
      el.gpuPanel.classList.add('is-off');
      el.gpuBadge.textContent = '无 GPU';
      el.gpuName.textContent = '未检测到 NVIDIA GPU 或 nvidia-smi 不可用';
      el.gpuUtil.textContent = '—';
      el.gpuMem.textContent = '—';
      el.gpuTemp.textContent = '—';
      el.gpuBar.style.width = '0%';
      return;
    }
    el.gpuPanel.classList.remove('is-off');
    el.gpuBadge.textContent = '实时';
    el.gpuName.textContent = g.name || 'NVIDIA GPU';
    el.gpuUtil.textContent = g.utilization + '%';
    el.gpuMem.textContent = (g.memoryUsed / 1024).toFixed(1) + '/' + Math.round(g.memoryTotal / 1024) + 'G';
    el.gpuTemp.textContent = g.temperature + '°C';
    el.gpuBar.style.width = Math.min(100, g.utilization) + '%';
    el.gpuBar.style.background = g.utilization > 85 ? '#d93a2f' : (g.utilization > 55 ? '#c58a00' : '#30a14e');
  } catch (_) {}
}
pollGPU();
setInterval(() => { if (!document.hidden) pollGPU(); }, 3000);
