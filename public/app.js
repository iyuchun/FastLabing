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
let region = [];            // 划线允许区域（视频坐标，闭合多边形），空数组表示不限制
let regionContain = 'center'; // 区域内框的判定方式：center=中心点在区域内；full=框边缘在区域内
let regionMode = false;     // 是否正在绘制划线区域
let regionDraft = [];       // 正在绘制的区域顶点
let regionCursor = null;    // 划线预览光标
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
  btnRegion: $('btnRegion'), btnClearRegion: $('btnClearRegion'), regionContain: $('regionContain'),
  qaBadge: $('qaBadge'), qaHint: $('qaHint'), qaOverlap: $('qaOverlap'),
  btnQa: $('btnQa'), btnQaFix: $('btnQaFix'), btnQaDeep: $('btnQaDeep'), qaDeepAutoFix: $('qaDeepAutoFix'),
  qaDeepMsg: $('qaDeepMsg'), qaSummary: $('qaSummary'), qaList: $('qaList'),
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
  projectNewBtn: $('projectNewBtn'), projectList: $('projectList'), projectSearch: $('projectSearch'),
  // 导入别人标注好的数据集
  btnImportDataset: $('btnImportDataset'), projectImportBtn: $('projectImportBtn'),
  importModal: $('importModal'), importClose: $('importClose'), importCancel: $('importCancel'),
  importPick: $('importPick'), importFile: $('importFile'), importFileName: $('importFileName'),
  importPassword: $('importPassword'), importName: $('importName'), importMsg: $('importMsg'),
  importConfirm: $('importConfirm')
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
  if (el.btnQa) el.btnQa.disabled = !meta;
  if (el.btnQaFix) el.btnQaFix.disabled = !meta;
  updateQaDeepUI();
  updateRegionUI();
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
  undoStack.push(JSON.stringify({ annotations, region, regionContain }));
  if (undoStack.length > 200) undoStack.shift();
  invalidateQa();
}

function undo() {
  if (!undoStack.length) return;
  const state = JSON.parse(undoStack.pop());
  annotations = (state && state.annotations) || {};
  region = Array.isArray(state && state.region) ? state.region : [];
  regionContain = state && state.regionContain === 'full' ? 'full' : 'center';
  selectedIndex = -1;
  invalidateQa();
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

  drawRegionOverlay();

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
  const valid = region.length < 3 || boxAllowedInRegion({ x, y, w, h }, region);
  ctx.lineWidth = 2;
  ctx.strokeStyle = valid ? '#00e676' : '#ff453a';
  ctx.fillStyle = valid ? 'rgba(0,230,118,0.15)' : 'rgba(255,69,58,0.12)';
  ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
}

// ===================== 命中检测 =====================
function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

// ===================== 划线区域 =====================
function pointOnSegment(p, a, b) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 0.5) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < -0.5) return false;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= len2 + 0.5;
}

function pointInPolygon(p, poly) {
  // 边界上的点也算在区域内
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (pointOnSegment(p, poly[j], poly[i])) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsProperlyIntersect(a, b, c, d) {
  const o1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const o2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  const o3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const o4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function polygonSelfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsProperlyIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

function polygonArea(poly) {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return sum / 2;
}

// 框的边缘在区域内：四个角都在区域内，且没有区域边穿过框
function boxFullyInsideRegion(b, poly) {
  if (!poly || poly.length < 3) return true;
  const x1 = Math.min(b.x, b.x + b.w), x2 = Math.max(b.x, b.x + b.w);
  const y1 = Math.min(b.y, b.y + b.h), y2 = Math.max(b.y, b.y + b.h);
  if (!(x2 > x1) || !(y2 > y1)) return false;
  const corners = [
    { x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }
  ];
  if (!corners.every((p) => pointInPolygon(p, poly))) return false;
  const edges = [
    [corners[0], corners[1]], [corners[1], corners[2]],
    [corners[2], corners[3]], [corners[3], corners[0]]
  ];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b2 = poly[(i + 1) % poly.length];
    for (const [c, d] of edges) {
      if (segmentsProperlyIntersect(a, b2, c, d)) return false;
    }
  }
  return true;
}

// 框中心点是否在区域内
function boxCenterInRegion(b, poly) {
  if (!poly || poly.length < 3) return true;
  const x1 = Math.min(b.x, b.x + b.w), x2 = Math.max(b.x, b.x + b.w);
  const y1 = Math.min(b.y, b.y + b.h), y2 = Math.max(b.y, b.y + b.h);
  if (!(x2 > x1) || !(y2 > y1)) return false;
  return pointInPolygon({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, poly);
}

// 按当前判定方式判断框是否允许保留在区域内
function boxAllowedInRegion(b, poly, mode) {
  if (!poly || poly.length < 3) return true;
  const m = mode || regionContain;
  return m === 'full' ? boxFullyInsideRegion(b, poly) : boxCenterInRegion(b, poly);
}

function regionContainLabel(mode) {
  return (mode || regionContain) === 'full' ? '框边缘在区域内' : '框中心点在区域内';
}

function normalizeRegion(raw) {
  if (!Array.isArray(raw)) return [];
  const pts = raw
    .map((p) => ({ x: Number(p && p.x), y: Number(p && p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return pts.length >= 3 ? pts : [];
}

function updateRegionUI() {
  if (!el.btnRegion) return;
  const ready = !!meta;
  el.btnRegion.disabled = !ready;
  el.btnRegion.classList.toggle('active', regionMode);
  el.btnRegion.title = regionMode
    ? '划线中：点击添加顶点，双击或回车闭合，Esc 取消'
    : (region.length >= 3
      ? `重新绘制允许区域（当前判定：${regionContainLabel()}，会丢弃区域外的框）`
      : `画一个闭合区域，只有符合「${regionContainLabel()}」的框才会保留`);
  if (el.btnClearRegion) el.btnClearRegion.disabled = !ready || region.length < 3;
  if (el.regionContain) {
    el.regionContain.disabled = !ready;
    el.regionContain.value = regionContain;
    el.regionContain.title = '划线区域内框的判定方式：一种是框中心点在区域内；另一种是框的整条边缘都在区域内';
  }
  updateAutoScopeUI();
}

function addRegionPoint(p) {
  const W = canvas.width || (meta && meta.width) || 0;
  const H = canvas.height || (meta && meta.height) || 0;
  const pt = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
  if (regionDraft.length >= 3) {
    const first = regionDraft[0];
    if (Math.hypot(pt.x - first.x, pt.y - first.y) <= 14) {
      finishRegionDraw();
      return;
    }
  }
  regionDraft.push(pt);
  regionCursor = pt;
  draw();
  setStatus(`划线中：已添加 ${regionDraft.length} 个顶点，双击/回车闭合，Esc 取消`);
}

function startRegionDraw() {
  if (!meta) return;
  if (autoRunning) { setStatus('自动打标运行中，暂不能修改划线区域'); return; }
  if (regionMode) { cancelRegionDraw(); return; }
  regionMode = true;
  regionDraft = [];
  regionCursor = null;
  selectedIndex = -1;
  drag = null;
  canvas.style.cursor = 'crosshair';
  setStatus('划线模式：点击添加顶点，双击或回车闭合，Esc 取消');
  updateRegionUI();
  draw();
}

function cancelRegionDraw() {
  if (!regionMode) return;
  regionMode = false;
  regionDraft = [];
  regionCursor = null;
  setStatus('已取消划线');
  updateRegionUI();
  draw();
}

function finishRegionDraw() {
  if (!regionMode) return;
  const pts = [];
  for (const p of regionDraft) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 3) pts.push(p);
  }
  if (pts.length >= 2) {
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 3) pts.pop();
  }
  if (pts.length < 3) {
    setStatus('至少需要 3 个顶点才能形成区域，请继续点击');
    return;
  }
  if (polygonSelfIntersects(pts)) {
    setStatus('划线的边不能交叉，请重新绘制');
    return;
  }
  if (Math.abs(polygonArea(pts)) < 100) {
    setStatus('划线区域太小，请重新绘制');
    return;
  }
  const outside = countBoxesOutsideRegion(pts);
  if (outside > 0 && !confirm(`按「${regionContainLabel()}」判定，划线区域外有 ${outside} 个框将被丢弃。是否继续？`)) {
    return;
  }
  snapshot();
  region = pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  regionMode = false;
  regionDraft = [];
  regionCursor = null;
  const removed = filterAnnotationsByRegion();
  selectedIndex = -1;
  save();
  refreshAll();
  setStatus(`已设置划线区域（${regionContainLabel()}）${removed ? '，丢弃 ' + removed + ' 个框' : ''}`);
  updateRegionUI();
}

function countBoxesOutsideRegion(poly, mode) {
  if (!poly || poly.length < 3) return 0;
  let count = 0;
  for (const k in annotations) {
    const arr = annotations[k];
    if (!Array.isArray(arr)) continue;
    for (const b of arr) if (b && !boxAllowedInRegion(b, poly, mode)) count++;
  }
  return count;
}

function filterAnnotationsByRegion() {
  if (region.length < 3) return 0;
  let removed = 0;
  for (const k in annotations) {
    const arr = annotations[k];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((b) => b && boxAllowedInRegion(b, region));
    removed += arr.length - kept.length;
    annotations[k] = kept;
  }
  return removed;
}

function drawRegionOverlay() {
  if (!regionMode && region.length >= 3) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(region[0].x, region[0].y);
    for (let i = 1; i < region.length; i++) ctx.lineTo(region[i].x, region[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,230,118,.055)';
    ctx.fill();
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#00e676';
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.lineWidth = 1;
    for (const p of region) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  if (regionMode && regionDraft.length) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(regionDraft[0].x, regionDraft[0].y);
    for (let i = 1; i < regionDraft.length; i++) ctx.lineTo(regionDraft[i].x, regionDraft[i].y);
    if (regionCursor) ctx.lineTo(regionCursor.x, regionCursor.y);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = '#00e676';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i < regionDraft.length; i++) {
      const p = regionDraft[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 && regionDraft.length >= 3 ? '#ffffff' : '#00e676';
      ctx.fill();
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }
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
  if (regionMode) {
    addRegionPoint(p);
    return;
  }
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
  if (regionMode) {
    regionCursor = toCanvas(e);
    draw();
    return;
  }
  if (!drag) { updateCursor(e); return; }
  const p = toCanvas(e);
  if (drag.mode === 'draw') {
    drag.curX = p.x; drag.curY = p.y;
    draw(); drawPreview();
  } else if (drag.mode === 'move') {
    const b = peekBoxes(currentFrame)[selectedIndex];
    if (!b) return;
    const cand = {
      ...drag.orig,
      x: drag.orig.x + (p.x - drag.startX),
      y: drag.orig.y + (p.y - drag.startY)
    };
    if (region.length >= 3 && !boxAllowedInRegion(cand, region)) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    b.x = cand.x; b.y = cand.y;
    draw();
  } else if (drag.mode === 'resize') {
    const b = peekBoxes(currentFrame)[selectedIndex];
    if (!b) return;
    const cand = { ...drag.orig };
    resizeBox(cand, drag.orig, drag.handle, p);
    if (region.length >= 3 && !boxAllowedInRegion(cand, region)) return;
    if (!drag.moved) { snapshot(); drag.moved = true; }
    Object.assign(b, cand);
    draw();
  }
});

canvas.addEventListener('mouseup', () => {
  if (regionMode) return;
  if (!drag) return;
  if (drag.mode === 'draw') {
    const x = Math.min(drag.startX, drag.curX), y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX), h = Math.abs(drag.curY - drag.startY);
    if (w >= 3 && h >= 3) {
      const box = { id: getNewBoxId(), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      if (region.length >= 3 && !boxAllowedInRegion(box, region)) {
        setStatus(`按「${regionContainLabel()}」判定，该框不在划线区域内，本次画框已取消`);
      } else {
        snapshot();
        getBoxes(currentFrame).push(box);
        selectedIndex = peekBoxes(currentFrame).length - 1;
        refreshAll(); save();
      }
    }
  } else if (drag.mode === 'move' || drag.mode === 'resize') {
    if (drag.moved) {
      const b = peekBoxes(currentFrame)[selectedIndex];
      if (b) {
        normalizeBox(b);
        if (region.length >= 3 && !boxAllowedInRegion(b, region)) {
          Object.assign(b, drag.orig);
          setStatus(`按「${regionContainLabel()}」判定，框不符合区域要求，已恢复原位`);
        }
      }
      refreshAll(); save();
    } else {
      refreshBoxList(); refreshSelectedPanel(); draw();
    }
  }
  drag = null;
  draw();
});

canvas.addEventListener('dblclick', (e) => {
  if (!regionMode) return;
  e.preventDefault();
  if (regionDraft.length >= 2) {
    const a = regionDraft[regionDraft.length - 1];
    const b = regionDraft[regionDraft.length - 2];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 10) regionDraft.pop();
  }
  finishRegionDraw();
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
  if (regionMode) { canvas.style.cursor = 'crosshair'; return; }
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
      annotations,
      region,
      regionContain
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
    region = []; regionContain = 'center'; regionMode = false; regionDraft = []; regionCursor = null;
    undoStack = [];
    resetQaState();
    resetQaDeepState(true);
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

// ===================== 导入别人标注好的数据集（加密 ZIP → 项目） =====================
let importBusy = false;

function setImportMsg(text, kind) {
  if (!el.importMsg) return;
  el.importMsg.textContent = text || '';
  el.importMsg.className = 'import-msg' + (kind ? ' is-' + kind : '');
}

function openImportDataset() {
  if (importBusy) return;
  el.projectModal.hidden = true;
  el.importFile.value = '';
  el.importFileName.textContent = '未选择';
  el.importName.value = '';
  el.importName.placeholder = '默认使用数据集来源名称';
  el.importConfirm.disabled = true;
  setImportMsg('');
  el.importModal.hidden = false;
}

function closeImportDataset() {
  if (importBusy) return;
  el.importModal.hidden = true;
}

el.btnImportDataset.addEventListener('click', openImportDataset);
if (el.projectImportBtn) el.projectImportBtn.addEventListener('click', openImportDataset);
el.importClose.addEventListener('click', closeImportDataset);
el.importCancel.addEventListener('click', closeImportDataset);
el.importModal.addEventListener('click', (e) => {
  if (e.target === el.importModal) closeImportDataset();
});
el.importPick.addEventListener('click', () => el.importFile.click());
el.importFile.addEventListener('change', () => {
  const f = el.importFile.files[0];
  el.importFileName.textContent = f ? f.name : '未选择';
  el.importConfirm.disabled = !f || importBusy;
  setImportMsg('');
  if (f) {
    const base = f.name.replace(/\.zip$/i, '').replace(/^数据集[_\-\s]*/i, '').replace(/_\d{10,}$/, '');
    el.importName.placeholder = '默认：' + (base || '导入数据集');
  }
});

el.importConfirm.addEventListener('click', async () => {
  const f = el.importFile.files[0];
  if (!f || importBusy) {
    if (!f) setImportMsg('请先选择数据集 ZIP 压缩包', 'error');
    return;
  }

  importBusy = true;
  el.importConfirm.disabled = true;
  el.importClose.disabled = true;
  el.importCancel.disabled = true;
  el.importPick.disabled = true;
  setImportMsg('正在上传并解压数据集，请稍候…');

  const fd = new FormData();
  fd.append('archive', f);
  fd.append('password', el.importPassword.value || '');
  fd.append('name', el.importName.value.trim());

  try {
    const r = await fetch('/api/import-dataset', { method: 'POST', body: fd });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(data.error || ('导入失败（HTTP ' + r.status + '）'));

    setImportMsg(`导入成功：${data.frames} 帧 / ${data.boxes} 个框，正在打开项目…`, 'ok');
    await applyProject(
      data.projectId,
      `已导入数据集：${data.frames} 帧 · ${data.boxes} 个框`,
      data.name
    );
    if (data.categoryName) el.categoryName.value = data.categoryName;
    el.importModal.hidden = true;
    setStatus(`数据集导入完成：${data.frames} 帧，${data.boxes} 个标注框，可开始审查与修改`);
  } catch (err) {
    setImportMsg(friendlyError('导入数据集', err), 'error');
  } finally {
    importBusy = false;
    el.importClose.disabled = false;
    el.importCancel.disabled = false;
    el.importPick.disabled = false;
    el.importConfirm.disabled = !el.importFile.files[0];
  }
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
  const qa = runQualityCheck(true);
  if (qa.errors || qa.warnings) {
    const ok = confirm(
      `质检发现 ${qa.errors} 个错误、${qa.warnings} 个提醒（重复框 / 同帧重复 ID / ID 断层跳变等）。\n` +
      `建议先在右侧「标注质检」中定位并修正。\n\n仍要导出吗？`
    );
    if (!ok) { setStatus('已取消导出，请先处理质检问题'); return; }
  }
  const catName = el.categoryName.value.trim() || 'object';
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { await doSave(); } catch (_) {}
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

if (el.btnRegion) el.btnRegion.addEventListener('click', startRegionDraw);
if (el.regionContain) {
  el.regionContain.addEventListener('change', () => {
    const next = el.regionContain.value === 'full' ? 'full' : 'center';
    if (next === regionContain) return;
    if (autoRunning) {
      el.regionContain.value = regionContain;
      setStatus('自动打标运行中，暂不能修改区域判定方式');
      return;
    }
    if (next === 'full' && region.length >= 3) {
      const outside = countBoxesOutsideRegion(region, 'full');
      if (outside > 0 && !confirm(`切换为「框边缘在区域内」后，有 ${outside} 个框将被丢弃。是否继续？`)) {
        el.regionContain.value = regionContain;
        return;
      }
    }
    snapshot();
    regionContain = next;
    const removed = next === 'full' ? filterAnnotationsByRegion() : 0;
    save();
    refreshAll();
    setStatus(`区域判定方式已切换为「${regionContainLabel()}」${removed ? '，丢弃 ' + removed + ' 个框' : ''}`);
  });
}
if (el.btnClearRegion) {
  el.btnClearRegion.addEventListener('click', () => {
    if (!region.length) return;
    if (autoRunning) { setStatus('自动打标运行中，暂不能修改划线区域'); return; }
    if (!confirm('清除划线区域？区域外已丢弃的框不会恢复。')) return;
    snapshot();
    region = [];
    regionMode = false;
    regionDraft = [];
    regionCursor = null;
    save();
    refreshAll();
    setStatus('已清除划线区域');
    updateRegionUI();
  });
}

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
  let regionSkipped = 0;
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
          if (region.length >= 3 && !boxAllowedInRegion(nb, region)) {
            regionSkipped++;
            prev = { x: nb.x, y: nb.y, w: nb.w, h: nb.h };
            continue;
          }
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
    const qa = runQualityCheck(true);
    setTrackStatus(
      '跟踪完成：' +
      (skippedFrames ? `跳过 ${skippedFrames} 帧已有标注，` : '') +
      (regionSkipped ? `跳过 ${regionSkipped} 帧区域外结果，` : '') +
      `写入 ${writtenFrames} 帧` +
      (overwrittenFrames ? `（覆盖 ${overwrittenFrames} 帧）` : '') +
      ((qa.errors || qa.warnings)
        ? `；质检发现 ${qa.errors} 个错误、${qa.warnings} 个提醒`
        : '；质检通过')
    );
  }
});

// ===================== 标注质检 =====================
const QA_LIST_LIMIT = 150;
let qaIssues = [];
let qaStats = { checked: false, errors: 0, warnings: 0, frameCount: 0, boxCount: 0, threshold: 0.7 };

// AI 深度质检：服务端用 SAM3 重新检测每个框，输出「框内多人 / 框不贴合 / 框内无目标」建议
let qaDeep = { suggestions: [], summary: null, startFrame: 0, count: 0 };
let qaDeepJobId = null;
let qaDeepRunning = false;
let qaDeepPollFails = 0;
let qaDeepPollToken = 0;

function qaOverlapThreshold() {
  const v = parseFloat(el.qaOverlap && el.qaOverlap.value);
  if (!Number.isFinite(v)) return 0.7;
  return Math.max(0.3, Math.min(1, v));
}

function boxArea(b) { return Math.max(0, b.w) * Math.max(0, b.h); }

function boxInterArea(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 0 && iy > 0 ? ix * iy : 0;
}

function boxIou(a, b) {
  const inter = boxInterArea(a, b);
  if (!inter) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

function boxCenter(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

function resetQaState() {
  qaIssues = [];
  qaStats = { checked: false, errors: 0, warnings: 0, frameCount: 0, boxCount: 0, threshold: qaOverlapThreshold() };
  if (el.qaBadge) { el.qaBadge.textContent = '未检查'; el.qaBadge.className = 'badge'; }
  if (el.qaSummary) el.qaSummary.textContent = '';
  if (el.qaList) el.qaList.innerHTML = '';
}

function invalidateQa() {
  if (qaStats.checked) resetQaState();
}

// 全量质检：框重叠重复、同帧重复 ID、ID 断层 / 跳变 / 互换
function runQualityCheck(quiet) {
  if (!meta || !projectId) {
    resetQaState();
    return qaStats;
  }
  const threshold = qaOverlapThreshold();
  const total = Number(meta.count) || 0;
  const issues = [];
  const trackFrames = new Map();
  let boxCount = 0;

  for (let f = 1; f <= total; f++) {
    const boxes = peekBoxes(f).filter(Boolean);
    if (!boxes.length) continue;
    boxCount += boxes.length;

    const byId = new Map();
    for (const b of boxes) {
      const id = Number(b.id);
      if (!trackFrames.has(id)) trackFrames.set(id, []);
      trackFrames.get(id).push(f);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(b);
    }

    // 同一帧同一 ID 出现多个框
    for (const [id, list] of byId) {
      if (list.length < 2) continue;
      const sorted = list.slice().sort((a, b) => boxArea(b) - boxArea(a));
      issues.push({
        type: 'dupId', severity: 'error', frame: f, ids: [id],
        text: `同一帧出现 ${list.length} 个 ID ${id} 的框，将保留最大框并删除其余 ${list.length - 1} 个`,
        fix: { kind: 'dropBoxes', frame: f, drop: sorted.slice(1) },
        focus: { frame: f, id }
      });
    }

    // 不同 ID 的框重叠重复：交集 ÷ 较小框面积 >= 阈值
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (Number(a.id) === Number(b.id)) continue;
        const minArea = Math.min(boxArea(a), boxArea(b));
        const inter = boxInterArea(a, b);
        if (minArea <= 0 || inter <= 0) continue;
        const cover = inter / minArea;
        if (cover < threshold) continue;
        const small = boxArea(a) <= boxArea(b) ? a : b;
        const big = small === a ? b : a;
        issues.push({
          type: 'overlap', severity: 'error', frame: f, ids: [Number(a.id), Number(b.id)],
          text: `ID ${a.id} 与 ID ${b.id} 重叠 ${Math.round(cover * 100)}%（阈值 ${Math.round(threshold * 100)}%），疑似重复标注`,
          fix: { kind: 'dropBoxes', frame: f, drop: [small] },
          focus: { frame: f, id: Number(big.id) }
        });
      }
    }
  }

  // 单个 ID 的跨帧一致性
  const sortedIds = Array.from(trackFrames.keys()).sort((a, b) => a - b);
  for (const id of sortedIds) {
    const frames = Array.from(new Set(trackFrames.get(id))).sort((a, b) => a - b);
    if (!frames.length) continue;

    if (frames.length === 1 && total > 1) {
      issues.push({
        type: 'single', severity: 'warn', frame: frames[0], ids: [id],
        text: `ID ${id} 只出现 1 帧（第 ${frames[0]} 帧），可能是漏标或错标`,
        focus: { frame: frames[0], id }
      });
    }

    // 中间断层：同一目标出现后应连续到消失
    for (let k = 1; k < frames.length; k++) {
      const gap = frames[k] - frames[k - 1] - 1;
      if (gap <= 0) continue;
      issues.push({
        type: 'gap', severity: 'warn', frame: frames[k - 1] + 1, ids: [id],
        text: `ID ${id} 在第 ${frames[k - 1] + 1}–${frames[k] - 1} 帧缺失（共 ${gap} 帧），该目标应连续存在`,
        focus: { frame: frames[k - 1] + 1, id }
      });
    }

    // 相邻出现帧的位移 / 尺寸突变
    for (let k = 1; k < frames.length; k++) {
      const f0 = frames[k - 1], f1 = frames[k];
      const prev = boxWithId(f0, id);
      const next = boxWithId(f1, id);
      if (!prev || !next) continue;
      const step = Math.max(1, f1 - f0);
      const c0 = boxCenter(prev), c1 = boxCenter(next);
      const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
      const size = Math.max(prev.w, prev.h, 1);
      const iou0 = boxIou(prev, next);
      const jump = step === 1
        ? (iou0 < 0.1 && dist > 0.9 * size)
        : (dist > 1.5 * size * step);
      const rw = next.w / Math.max(prev.w, 1);
      const rh = next.h / Math.max(prev.h, 1);
      const sizeJump = rw < 0.4 || rw > 2.5 || rh < 0.4 || rh > 2.5;
      if (!jump && !sizeJump) continue;
      const detail = jump
        ? `中心位移 ${Math.round(dist)}px（框 ${Math.round(prev.w)}×${Math.round(prev.h)}），疑似串到其他目标`
        : `框尺寸突变（宽 ${Math.round(rw * 100)}%、高 ${Math.round(rh * 100)}%）`;
      issues.push({
        type: 'jump', severity: 'error', frame: f1, ids: [id],
        text: `ID ${id} 从第 ${f0} 帧到第 ${f1} 帧${detail}`,
        focus: { frame: f1, id }
      });
    }
  }

  // 相邻帧两个 ID 位置互换（串号）
  const switchLastFrame = new Map();
  for (let f = 1; f < total; f++) {
    const cur = peekBoxes(f).filter(Boolean);
    const nxt = peekBoxes(f + 1).filter(Boolean);
    if (cur.length < 2 || nxt.length < 2) continue;
    const idsCur = Array.from(new Set(cur.map((b) => Number(b.id)))).sort((a, b) => a - b);
    const nextById = new Map();
    for (const b of nxt) {
      const id = Number(b.id);
      if (!nextById.has(id)) nextById.set(id, b);
    }
    for (let i = 0; i < idsCur.length; i++) {
      for (let j = i + 1; j < idsCur.length; j++) {
        const idA = idsCur[i], idB = idsCur[j];
        const a0 = cur.find((b) => Number(b.id) === idA);
        const b0 = cur.find((b) => Number(b.id) === idB);
        const a1 = nextById.get(idA), b1 = nextById.get(idB);
        if (!a0 || !b0 || !a1 || !b1) continue;
        const aa = boxIou(a0, a1), bb = boxIou(b0, b1);
        const ab = boxIou(a0, b1), ba = boxIou(b0, a1);
        if (!(ab > aa + 0.25 && ba > bb + 0.25 && ab > 0.2 && ba > 0.2)) continue;
        const pairKey = Math.min(idA, idB) + '-' + Math.max(idA, idB);
        const last = switchLastFrame.get(pairKey);
        switchLastFrame.set(pairKey, f);
        if (last != null && f - last <= 1) continue;  // 连续互换段只报一次
        issues.push({
          type: 'switch', severity: 'error', frame: f + 1, ids: [idA, idB],
          text: `ID ${idA} 与 ID ${idB} 在第 ${f}→${f + 1} 帧位置互换，疑似串号`,
          fix: { kind: 'swapIds', fromFrame: f + 1, idA, idB },
          focus: { frame: f + 1, id: idA }
        });
      }
    }
  }

  // AI 深度质检建议：框内多人 / 框不贴合 / 框内未检出
  for (const issue of qaDeepIssues()) issues.push(issue);

  issues.sort((a, b) => (a.frame - b.frame) ||
    (a.severity === b.severity ? 0 : (a.severity === 'error' ? -1 : 1)));

  qaIssues = issues;
  qaStats = {
    checked: true,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
    frameCount: total,
    boxCount,
    threshold
  };
  renderQa();
  if (!quiet) {
    const n = qaStats.errors + qaStats.warnings;
    setStatus(n
      ? `质检完成：发现 ${qaStats.errors} 个错误、${qaStats.warnings} 个提醒，可在右侧「标注质检」定位修正`
      : `质检通过：${total} 帧、${boxCount} 个框未发现问题`);
  }
  return qaStats;
}

function renderQa() {
  if (!el.qaList) return;
  const s = qaStats;
  if (el.qaBadge) {
    el.qaBadge.className = 'badge' + (s.errors ? ' err' : (s.warnings ? ' warn' : ''));
    el.qaBadge.textContent = s.errors ? s.errors + ' 个错误' : (s.warnings ? s.warnings + ' 个提醒' : '通过');
  }
  if (!s.checked) return;

  const shown = Math.min(qaIssues.length, QA_LIST_LIMIT);
  el.qaSummary.innerHTML =
    `已检查 <b>${s.frameCount}</b> 帧 / <b>${s.boxCount}</b> 个框 · 重叠阈值 <b>${Math.round(s.threshold * 100)}%</b><br>` +
    (s.errors || s.warnings
      ? `<span class="is-err">${s.errors} 个错误</span> · <span class="is-warn">${s.warnings} 个提醒</span>` +
        (qaIssues.length > shown ? `（仅显示前 ${shown} 条）` : '')
      : '未发现异常');

  el.qaList.innerHTML = '';
  if (!qaIssues.length) {
    el.qaList.innerHTML = '<div class="qa-empty">无需处理</div>';
    return;
  }
  for (let i = 0; i < shown; i++) {
    const issue = qaIssues[i];
    const item = document.createElement('div');
    item.className = 'qa-item ' + (issue.severity === 'error' ? 'err' : 'warn');
    const head = document.createElement('div');
    head.className = 'qa-item-head';
    const fr = document.createElement('span');
    fr.className = 'qa-frame';
    fr.textContent = '#' + issue.frame;
    const txt = document.createElement('span');
    txt.className = 'qa-text';
    txt.textContent = issue.text;
    head.appendChild(fr);
    head.appendChild(txt);
    item.appendChild(head);

    const acts = document.createElement('div');
    acts.className = 'qa-actions';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.textContent = '定位';
    jump.addEventListener('click', () => focusQaIssue(issue));
    acts.appendChild(jump);
    if (issue.fix) {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'danger';
      fix.textContent = issue.fix.kind === 'swapIds' ? '交换此后 ID'
        : issue.fix.kind === 'deepSplit' ? '拆分并修正 ID'
        : issue.fix.kind === 'deepTighten' ? '收紧此框'
        : issue.fix.kind === 'deepDrop' ? '删除非人框'
        : '删除重复框';
      fix.addEventListener('click', () => applyQaFix(issue));
      acts.appendChild(fix);
    }
    item.appendChild(acts);
    el.qaList.appendChild(item);
  }
}

function focusQaIssue(issue) {
  if (!meta || !issue || !issue.focus) return;
  goToFrame(issue.focus.frame);
  const arr = peekBoxes(currentFrame);
  let idx = issue.focus.box
    ? arr.findIndex((b) => qaDeepBoxMatch(b, issue.focus.box))
    : -1;
  if (idx < 0) idx = arr.findIndex((b) => b && Number(b.id) === Number(issue.focus.id));
  if (idx < 0 && issue.fix && issue.fix.drop && issue.fix.drop[0]) {
    const t = issue.fix.drop[0];
    idx = arr.findIndex((b) => b && Number(b.id) === Number(t.id) &&
      Number(b.x) === Number(t.x) && Number(b.y) === Number(t.y));
  }
  if (idx >= 0) {
    selectedIndex = idx;
    refreshBoxList();
    refreshSelectedPanel();
    draw();
  }
}

function applyQaFix(issue) {
  if (!issue || !issue.fix) return;
  if (issue.fix.kind === 'deepSplit' || issue.fix.kind === 'deepTighten' || issue.fix.kind === 'deepDrop') {
    applyDeepQaFix(issue);
    return;
  }
  snapshot();
  if (issue.fix.kind === 'dropBoxes') {
    const arr = getBoxes(issue.fix.frame);
    for (const target of issue.fix.drop) {
      let idx = arr.findIndex((b) => b && Number(b.id) === Number(target.id) &&
        Number(b.x) === Number(target.x) && Number(b.y) === Number(target.y) &&
        Number(b.w) === Number(target.w) && Number(b.h) === Number(target.h));
      if (idx < 0) idx = arr.findIndex((b) => b && Number(b.id) === Number(target.id));
      if (idx >= 0) arr.splice(idx, 1);
    }
  } else if (issue.fix.kind === 'swapIds') {
    const { fromFrame, idA, idB } = issue.fix;
    for (const k in annotations) {
      if (!(Number(k) >= fromFrame) || !Array.isArray(annotations[k])) continue;
      for (const b of annotations[k]) {
        if (!b) continue;
        const id = Number(b.id);
        if (id === idA) b.id = idB;
        else if (id === idB) b.id = idA;
      }
    }
  }
  refreshAll();
  save();
  runQualityCheck(true);
  setStatus('已修正：' + issue.text);
}

function boxCenterDist(a, b) {
  const c1 = boxCenter(a), c2 = boxCenter(b);
  return Math.hypot(c1.x - c2.x, c1.y - c2.y);
}

// ---------- AI 深度质检：建议 → 质检项 / 应用 ----------
function qaDeepBoxMatch(a, b, tol) {
  if (!a || !b) return false;
  if (Number(a.id) !== Number(b.id)) return false;
  const t = tol == null ? 8 : tol;
  return Math.abs(Number(a.x) - Number(b.x)) <= t &&
    Math.abs(Number(a.y) - Number(b.y)) <= t &&
    Math.abs(Number(a.w) - Number(b.w)) <= t &&
    Math.abs(Number(a.h) - Number(b.h)) <= t;
}

// 在帧内定位深度建议对应的框：先按原始几何精确匹配，再退回 ID
function qaDeepFindIndex(arr, s) {
  if (!s || !s.box) return -1;
  if (Number.isInteger(s.boxIndex) && s.boxIndex >= 0 && s.boxIndex < arr.length &&
    qaDeepBoxMatch(arr[s.boxIndex], s.box)) return s.boxIndex;
  let idx = arr.findIndex((b) => qaDeepBoxMatch(b, s.box));
  if (idx < 0) idx = arr.findIndex((b) => b && Number(b.id) === Number(s.box.id));
  return idx;
}

function qaDeepIssues() {
  const out = [];
  for (const s of qaDeep.suggestions) {
    const arr = peekBoxes(s.frame);
    if (qaDeepFindIndex(arr, s) < 0) continue;  // 框已被改动 / 删除，建议失效
    const id = Number(s.box && s.box.id);
    if (s.type === 'split') {
      out.push({
        type: 'deepSplit', severity: 'error', frame: s.frame, ids: [id],
        text: `第 ${s.frame} 帧 ID ${id} 的框内有 ${s.parts.length} 个人，将拆成 ${s.parts.length} 个框并按前后帧对齐 ID`,
        fix: { kind: 'deepSplit', suggestion: s },
        focus: { frame: s.frame, id, box: s.box }
      });
    } else if (s.type === 'tighten') {
      out.push({
        type: 'deepTighten', severity: 'warn', frame: s.frame, ids: [id],
        text: `第 ${s.frame} 帧 ID ${id} 的框不贴合（AI 目标仅占 ${Math.round((Number(s.cover) || 0) * 100)}%），将收紧到目标边缘`,
        fix: { kind: 'deepTighten', suggestion: s },
        focus: { frame: s.frame, id, box: s.box }
      });
    } else if (s.type === 'empty') {
      out.push({
        type: 'deepEmpty', severity: 'error', frame: s.frame, ids: [id],
        text: `第 ${s.frame} 帧 ID ${id} 的框内没有检出人物，将删除此框及前后帧同 ID 的框`,
        fix: { kind: 'deepDrop', suggestion: s },
        focus: { frame: s.frame, id, box: s.box }
      });
    }
  }
  return out;
}

function qaDeepContext() {
  const ids = collectIds();
  return {
    detMap: new Map(),
    allIds: new Set(ids),
    nextFree: ids.length ? Math.max(...ids) + 1 : 1
  };
}

function qaDeepAllocId(ctx) {
  let id = ctx.nextFree;
  while (ctx.allIds.has(id)) id++;
  ctx.nextFree = id + 1;
  ctx.allIds.add(id);
  return id;
}

// 拆分多人框：原 ID 留给与旧框重叠最大的那个人，其余块优先用 AI 跟踪 detId、
// 再参考前后帧同位置框的 ID，最后才分配新 ID，保证整段视频 ID 不跳变。
function qaDeepApplySplit(s, ctx) {
  const arr = getBoxes(s.frame);
  const idx = qaDeepFindIndex(arr, s);
  if (idx < 0) return false;
  const orig = arr[idx];
  const origId = Number(orig.id);
  const used = new Set();
  arr.forEach((b, i) => { if (i !== idx && b) used.add(Number(b.id)); });

  const prevById = new Map();
  for (const b of peekBoxes(s.frame - 1)) {
    const id = Number(b.id);
    if (!prevById.has(id)) prevById.set(id, b);
  }
  const nextById = new Map();
  for (const b of peekBoxes(s.frame + 1)) {
    const id = Number(b.id);
    if (!nextById.has(id)) nextById.set(id, b);
  }

  const parts = s.parts
    .filter((p) => !arr.some((b, i) => {
      if (i === idx || !b) return false;
      const inter = boxInterArea(b, p);
      const minA = Math.min(boxArea(b), boxArea(p));
      return minA > 0 && inter / minA >= 0.55;
    }))
    .map((p) => ({
      detId: p.detId, x: p.x, y: p.y, w: p.w, h: p.h, id: null
    }));
  if (parts.length < 2) return false;  // 拆分目标与已有框重复，放弃拆分

  // 1) 同一 AI 目标在其它帧拆分时已确定的 ID
  for (const part of parts) {
    if (part.detId == null) continue;
    const id = ctx.detMap.get(part.detId);
    if (id != null && !used.has(id)) part.id = id;
  }

  // 2) 原 ID 给与旧框重叠最大的那一块
  if (!used.has(origId)) {
    let best = null, bestIou = -1;
    for (const part of parts) {
      if (part.id != null) continue;
      const v = boxIou(orig, part);
      if (v > bestIou) { bestIou = v; best = part; }
    }
    if (best) best.id = origId;
  }

  // 3) 用前一帧 / 后一帧帮助剩余块对齐 ID
  const matchSide = (map, taken) => {
    const cands = [];
    for (const part of parts) {
      if (part.id != null) continue;
      for (const [pid, pb] of map) {
        if (used.has(pid) || taken.has(pid)) continue;
        const limit = Math.max(24, 1.2 * Math.max(pb.w, pb.h, 1));
        const dist = boxCenterDist(part, pb);
        if (dist > limit) continue;
        cands.push({ part, pid, score: boxIou(part, pb) + (1 - dist / limit) * 0.35 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) {
      if (c.part.id != null || taken.has(c.pid)) continue;
      c.part.id = c.pid;
      taken.add(c.pid);
    }
  };
  matchSide(prevById, new Set());
  matchSide(nextById, new Set());

  // 4) 剩余块分配新 ID
  for (const part of parts) if (part.id == null) part.id = qaDeepAllocId(ctx);

  // 同帧 ID 唯一性兜底
  const seen = new Set();
  for (const part of parts) {
    if (seen.has(part.id)) part.id = qaDeepAllocId(ctx);
    seen.add(part.id);
    if (part.detId != null) ctx.detMap.set(part.detId, part.id);
  }

  arr.splice(idx, 1, ...parts.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h })));
  return true;
}

function qaDeepApplyTighten(s) {  const arr = getBoxes(s.frame);
  const idx = qaDeepFindIndex(arr, s);
  if (idx < 0) return false;
  const box = arr[idx];
  box.x = s.to.x;
  box.y = s.to.y;
  box.w = s.to.w;
  box.h = s.to.h;
  normalizeBox(box);
  return true;
}

// 框内不是人：删除此框，并删除前后帧中同一 ID 的框，避免该 ID 继续残留
function qaDeepApplyDrop(s) {
  const arr = getBoxes(s.frame);
  const idx = qaDeepFindIndex(arr, s);
  if (idx < 0) return 0;
  const id = Number(arr[idx].id);
  let removed = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number(arr[i].id) === id) { arr.splice(i, 1); removed++; }
  }
  const total = Number(meta && meta.count) || 0;
  for (const f of [s.frame - 1, s.frame + 1]) {
    if (f < 1 || (total && f > total)) continue;
    const nb = peekBoxes(f);
    for (let i = nb.length - 1; i >= 0; i--) {
      if (Number(nb[i].id) === id) { nb.splice(i, 1); removed++; }
    }
  }
  return removed;
}

// 所有自动修正跑完后，再兜底清一次非人 ID，防止补断层 / 校准把非人框加回来
function qaDeepCleanupDrops(suggestions) {
  let removed = 0;
  const total = Number(meta && meta.count) || 0;
  for (const s of suggestions) {
    if (!s || s.type !== 'empty') continue;
    const id = Number(s.box && s.box.id);
    for (const f of [s.frame - 1, s.frame, s.frame + 1]) {
      if (f < 1 || (total && f > total)) continue;
      const arr = peekBoxes(f);
      for (let i = arr.length - 1; i >= 0; i--) {
        if (Number(arr[i].id) === id) { arr.splice(i, 1); removed++; }
      }
    }
  }
  return removed;
}

function applyDeepQaFix(issue) {
  const s = issue && issue.fix && issue.fix.suggestion;
  if (!s) return;
  const arr = peekBoxes(s.frame);
  if (qaDeepFindIndex(arr, s) < 0) {
    setStatus('该框已被修改，深度质检建议已失效，请重新运行 AI 深度质检');
    return;
  }
  snapshot();
  let ok = false;
  if (issue.fix.kind === 'deepSplit') ok = qaDeepApplySplit(s, qaDeepContext());
  else if (issue.fix.kind === 'deepTighten') ok = qaDeepApplyTighten(s);
  else if (issue.fix.kind === 'deepDrop') ok = qaDeepApplyDrop(s) > 0;
  if (!ok) { setStatus('修正失败：未找到目标框，或拆分目标与已有框重复'); return; }
  if (issue.fix.kind === 'deepSplit') autoReconcileIds();  // 拆分后按前后帧统一 ID
  qaDeep.suggestions = qaDeep.suggestions.filter((x) => x !== s);
  selectedIndex = -1;
  refreshAll();
  save();
  runQualityCheck(true);
  updateQaDeepUI();
  setStatus('已修正：' + issue.text);
}

// ---------- AI 深度质检：任务控制 ----------
function updateQaDeepUI() {
  if (!el.btnQaDeep) return;
  const span = el.btnQaDeep.querySelector('span');
  if (span) span.textContent = qaDeepRunning ? '取消深度质检' : 'AI 深度质检';
  el.btnQaDeep.classList.toggle('is-running', qaDeepRunning);
  el.btnQaDeep.disabled = !meta;
  el.btnQaDeep.title = qaDeepRunning
    ? '点击取消正在运行的 AI 深度质检'
    : '用 SAM 3 重新检测每个有标注的框（只扫描有框的帧）：框内多个人自动拆分，框过大 / 不贴合自动收紧，框内非人自动删除，拆分结果按前后帧对齐 ID';
}

function qaDeepSetMsg(text, on) {
  if (!el.qaDeepMsg) return;
  el.qaDeepMsg.textContent = text || '';
  el.qaDeepMsg.classList.toggle('is-on', !!on);
}

function resetQaDeepState(cancelRemote) {
  if (cancelRemote && qaDeepRunning && qaDeepJobId) {
    fetch('/api/quality/' + encodeURIComponent(qaDeepJobId) + '/cancel', { method: 'POST' }).catch(() => {});
  }
  qaDeepPollToken++;
  qaDeep = { suggestions: [], summary: null, startFrame: 0, count: 0 };
  qaDeepJobId = null;
  qaDeepRunning = false;
  qaDeepPollFails = 0;
  qaDeepSetMsg('');
  updateQaDeepUI();
}

function qaDeepSummaryText() {
  const s = qaDeep.summary;
  if (!s) return '';
  const parts = [];
  if (s.split) parts.push(`框内多人 ${s.split}`);
  if (s.tighten) parts.push(`框不贴合 ${s.tighten}`);
  if (s.empty) parts.push(`框内非人 ${s.empty}`);
  const head = `AI 深度质检：扫描 ${s.checkedFrames || 0} 个有框帧 / ${s.checkedBoxes || 0} 个框（第 ${qaDeep.startFrame}–${qaDeep.startFrame + qaDeep.count - 1} 帧）`;
  return head + ' · ' + (parts.length ? parts.join(' · ') : '未发现多人 / 非人 / 贴合问题');
}

async function cancelQaDeepScan() {
  const jobId = qaDeepJobId;
  qaDeepRunning = false;
  qaDeepJobId = null;
  qaDeepPollToken++;
  updateQaDeepUI();
  qaDeepSetMsg('深度质检已取消。');
  if (jobId) {
    try {
      await fetch('/api/quality/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' });
    } catch (_) {}
  }
}

async function startQaDeepScan() {
  if (!meta || !projectId) { setStatus('请先导入视频并分帧'); return; }
  if (autoRunning) { setStatus('AI 自动打标运行中，请完成后再做深度质检'); return; }

  const frames = Object.keys(annotations)
    .filter((k) => (annotations[k] || []).length)
    .map((k) => Math.round(Number(k)))
    .filter((f) => f >= 1);
  if (!frames.length) {
    setStatus('还没有任何标注框，无法做深度质检');
    qaDeepSetMsg('还没有标注框：先自动打标或手动画框，再做 AI 深度质检。');
    return;
  }
  const total = Number(meta.count) || 0;
  const startFrame = Math.max(1, Math.min(total, Math.min(...frames)));
  const count = Math.max(1, Math.min(total, Math.max(...frames)) - startFrame + 1);
  const prompt = String((autoEl.prompt && autoEl.prompt.value) || 'person').trim() || 'person';

  const submitPid = projectId;
  qaDeepRunning = true;
  qaDeepPollFails = 0;
  qaDeepPollToken++;
  qaDeep.suggestions = [];
  qaDeep.summary = null;
  qaDeep.startFrame = startFrame;
  qaDeep.count = count;
  updateQaDeepUI();
  qaDeepSetMsg(`正在提交深度质检任务（仅扫描 ${frames.length} 个有框帧，第 ${startFrame}–${startFrame + count - 1} 帧）…`, true);

  // 先把本地未落盘的标注同步给服务端，避免按旧标注生成建议
  try {
    clearTimeout(saveTimer);
    saveTimer = null;
    setSaveState(true);
    await doSave();
  } catch (_) {}
  if (projectId !== submitPid || !qaDeepRunning) return;

  let data = null;
  try {
    const r = await fetch('/api/quality/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: submitPid, startFrame, count, frames, prompt })
    });
    data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  } catch (err) {
    qaDeepRunning = false;
    qaDeepJobId = null;
    updateQaDeepUI();
    qaDeepSetMsg('深度质检启动失败：' + (err && err.message ? err.message : err));
    setStatus('AI 深度质检启动失败');
    return;
  }
  if (!data || !data.jobId) {
    qaDeepRunning = false;
    updateQaDeepUI();
    qaDeepSetMsg('后端未返回任务 ID，请检查服务端 /api/quality/scan');
    return;
  }
  if (projectId !== submitPid || !qaDeepRunning) return;
  qaDeepJobId = data.jobId;
  pollQaDeepJob(data.jobId, submitPid);
}

function finishQaDeepScan(job, pid) {
  const token = qaDeepPollToken;
  qaDeepRunning = false;
  qaDeepJobId = null;
  updateQaDeepUI();
  if (token !== qaDeepPollToken || projectId !== pid) return;

  if (job && job.status === 'done') {
    qaDeep.suggestions = Array.isArray(job.suggestions) ? job.suggestions : [];
    qaDeep.summary = job.summary || null;
    if (job.startFrame) qaDeep.startFrame = Number(job.startFrame);
    if (job.count) qaDeep.count = Number(job.count);
    updateQaDeepUI();
    qaDeepSetMsg(qaDeepSummaryText(), true);
    const qa = runQualityCheck(true);
    if (el.qaDeepAutoFix && el.qaDeepAutoFix.checked && qa.errors + qa.warnings > 0) {
      autoFixAllIssues({ silent: true });
      return;
    }
    setStatus(`AI 深度质检完成：发现 ${(job.summary && job.summary.split) || 0} 处框内多人、` +
      `${(job.summary && job.summary.tighten) || 0} 处框不贴合、${(job.summary && job.summary.empty) || 0} 处框内非人（将删除）；` +
      `质检共 ${qa.errors} 个错误、${qa.warnings} 个提醒，可点「一键修正全部」`);
  } else {
    const msg = (job && (job.error || job.message)) || '深度质检失败';
    updateQaDeepUI();
    qaDeepSetMsg('深度质检失败：' + msg);
    setStatus('AI 深度质检失败：' + msg);
  }
}

async function pollQaDeepJob(jobId, pid) {
  const token = qaDeepPollToken;
  while (qaDeepRunning && qaDeepJobId === jobId && qaDeepPollToken === token && projectId === pid) {
    await sleep(1200);
    if (!qaDeepRunning || qaDeepJobId !== jobId || qaDeepPollToken !== token || projectId !== pid) return;

    let job = null;
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch('/api/quality/' + encodeURIComponent(jobId), { cache: 'no-store', signal: ctrl.signal });
      if (!qaDeepRunning || qaDeepJobId !== jobId || qaDeepPollToken !== token) return;
      if (r.status === 404) {
        finishQaDeepScan({ status: 'error', error: '任务不存在或已丢失（服务可能已重启）' }, pid);
        return;
      }
      job = await r.json();
      if (!r.ok) throw new Error((job && job.error) || ('HTTP ' + r.status));
    } catch (err) {
      if (!qaDeepRunning || qaDeepJobId !== jobId || projectId !== pid) return;
      qaDeepPollFails++;
      if (qaDeepPollFails >= 20) {
        finishQaDeepScan({ status: 'error', error: '无法获取任务进度：' + (err && err.message ? err.message : err) }, pid);
        return;
      }
      qaDeepSetMsg(`与服务连接中断，正在重试（${qaDeepPollFails}/20）…`, true);
      continue;
    } finally {
      clearTimeout(abortTimer);
    }
    if (!qaDeepRunning || qaDeepJobId !== jobId || qaDeepPollToken !== token) return;
    qaDeepPollFails = 0;
    if (!job || !job.status) {
      finishQaDeepScan({ status: 'error', error: '任务状态丢失（服务可能已重启）' }, pid);
      return;
    }
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      finishQaDeepScan(job, pid);
      return;
    }
    qaDeepSetMsg(`深度质检中 ${Number(job.progress) || 0} / ${Number(job.total) || qaDeep.count} 帧 · ` +
      (job.message || '正在检测…'), true);
  }
}

if (el.btnQaDeep) {
  el.btnQaDeep.addEventListener('click', () => {
    if (qaDeepRunning) cancelQaDeepScan();
    else startQaDeepScan();
  });
}
if (el.qaDeepAutoFix) {
  if (localStorage.getItem('anno_qaDeepAutoFix') === '0') el.qaDeepAutoFix.checked = false;
  el.qaDeepAutoFix.addEventListener('change', () => {
    localStorage.setItem('anno_qaDeepAutoFix', el.qaDeepAutoFix.checked ? '1' : '0');
  });
}

// 自动删除：同帧重复 ID 保留最大框；不同 ID 重叠达到阈值删除较小框
function autoRemoveDuplicates() {
  const threshold = qaOverlapThreshold();
  const total = Number(meta && meta.count) || 0;
  let removed = 0;
  for (let f = 1; f <= total; f++) {
    const arr = peekBoxes(f);
    if (!arr.length) continue;
    const drop = new Set();

    const byId = new Map();
    for (const b of arr) {
      const id = Number(b.id);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(b);
    }
    for (const list of byId.values()) {
      if (list.length < 2) continue;
      const sorted = list.slice().sort((a, b) => boxArea(b) - boxArea(a));
      for (let i = 1; i < sorted.length; i++) drop.add(sorted[i]);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (drop.has(a)) continue;
        for (let j = i + 1; j < arr.length; j++) {
          const b = arr[j];
          if (drop.has(b) || Number(a.id) === Number(b.id)) continue;
          const minArea = Math.min(boxArea(a), boxArea(b));
          if (minArea <= 0) continue;
          if (boxInterArea(a, b) / minArea < threshold) continue;
          if (boxArea(a) < boxArea(b)) drop.add(a);
          else drop.add(b);
          changed = true;
          break;
        }
        if (drop.has(a)) break;
      }
    }

    if (drop.size) {
      annotations[String(f)] = arr.filter((b) => !drop.has(b));
      removed += drop.size;
    }
  }
  return removed;
}

// 单帧抖动：同一 ID 在第 f 帧突然远离前后两帧，用前后帧平均框拉回
function autoRepairSingleFrameSpikes() {
  const total = Number(meta && meta.count) || 0;
  let fixed = 0;
  for (const id of collectIds()) {
    const frames = [];
    for (let f = 1; f <= total; f++) if (boxWithId(f, id)) frames.push(f);
    for (let k = 1; k < frames.length - 1; k++) {
      const f0 = frames[k - 1], f1 = frames[k], f2 = frames[k + 1];
      if (f1 - f0 !== 1 || f2 - f1 !== 1) continue;
      const prev = boxWithId(f0, id), cur = boxWithId(f1, id), next = boxWithId(f2, id);
      if (!prev || !cur || !next) continue;
      const size = Math.max(prev.w, prev.h, 1);
      const farPrev = boxIou(prev, cur) < 0.05 && boxCenterDist(prev, cur) > size;
      const farNext = boxIou(next, cur) < 0.05 && boxCenterDist(next, cur) > size;
      const endsClose = boxIou(prev, next) > 0.1 || boxCenterDist(prev, next) < 0.8 * size;
      if (!(farPrev && farNext && endsClose)) continue;
      cur.x = Math.round((prev.x + next.x) / 2);
      cur.y = Math.round((prev.y + next.y) / 2);
      cur.w = Math.max(1, Math.round((prev.w + next.w) / 2));
      cur.h = Math.max(1, Math.round((prev.h + next.h) / 2));
      normalizeBox(cur);
      fixed++;
    }
  }
  return fixed;
}

// 以前一帧为基准做连续性核验：纠正 ID 跳变 / 串号 / 丢人后换新 ID
function autoReconcileIds() {
  const total = Number(meta && meta.count) || 0;
  const allIds = new Set(collectIds());
  let nextFree = allIds.size ? Math.max(...allIds) + 1 : 1;
  let fixed = 0;

  for (let f = 2; f <= total; f++) {
    const prevBoxes = peekBoxes(f - 1);
    const curBoxes = peekBoxes(f);
    if (!prevBoxes.length || !curBoxes.length) continue;

    const prevById = new Map();
    for (const b of prevBoxes) {
      const id = Number(b.id);
      if (!prevById.has(id)) prevById.set(id, b);
    }

    const cands = [];
    for (const [pid, pb] of prevById) {
      const size = Math.max(pb.w, pb.h, 1);
      const limit = Math.max(24, 1.2 * size);
      for (let i = 0; i < curBoxes.length; i++) {
        const dist = boxCenterDist(pb, curBoxes[i]);
        if (dist > limit) continue;
        cands.push({ pid, i, score: boxIou(pb, curBoxes[i]) + (1 - dist / limit) * 0.35 });
      }
    }
    if (!cands.length) continue;
    cands.sort((a, b) => b.score - a.score);

    const usedPid = new Set();
    const assigned = new Map();  // 当前帧框下标 -> 上一帧对应 ID
    for (const c of cands) {
      if (usedPid.has(c.pid) || assigned.has(c.i)) continue;
      usedPid.add(c.pid);
      assigned.set(c.i, c.pid);
    }
    if (!assigned.size) continue;

    for (const [i, pid] of assigned) {
      if (Number(curBoxes[i].id) !== pid) {
        curBoxes[i].id = pid;
        fixed++;
      }
    }

    // 未被匹配、却与已匹配框撞 ID 的，换一个新 ID，避免同帧重复
    const seen = new Set(assigned.values());
    for (let i = 0; i < curBoxes.length; i++) {
      if (assigned.has(i)) continue;
      let id = Number(curBoxes[i].id);
      if (seen.has(id)) {
        while (allIds.has(nextFree) || seen.has(nextFree)) nextFree++;
        id = nextFree;
        curBoxes[i].id = id;
        allIds.add(id);
        fixed++;
      }
      seen.add(id);
    }
  }
  return fixed;
}

// 补全短断层（默认 3 帧以内），用前后帧线性插值
function autoFillShortGaps(maxGap) {
  const total = Number(meta && meta.count) || 0;
  let filled = 0;
  for (const id of collectIds()) {
    const frames = [];
    for (let f = 1; f <= total; f++) if (boxWithId(f, id)) frames.push(f);
    for (let k = 1; k < frames.length; k++) {
      const f0 = frames[k - 1], f1 = frames[k];
      const gap = f1 - f0 - 1;
      if (gap <= 0 || gap > maxGap) continue;
      const a = boxWithId(f0, id), b = boxWithId(f1, id);
      if (!a || !b) continue;
      for (let f = f0 + 1; f < f1; f++) {
        const t = (f - f0) / (f1 - f0);
        const nb = {
          id,
          x: Math.round(a.x + (b.x - a.x) * t),
          y: Math.round(a.y + (b.y - a.y) * t),
          w: Math.max(1, Math.round(a.w + (b.w - a.w) * t)),
          h: Math.max(1, Math.round(a.h + (b.h - a.h) * t))
        };
        normalizeBox(nb);
        if (!boxAllowedInRegion(nb, region, regionContain)) continue;
        const arr = getBoxes(f);
        if (arr.some((x) => Number(x.id) === id)) continue;
        arr.push(nb);
        filled++;
      }
    }
  }
  return filled;
}

function autoFixAllIssues(options) {
  const silent = !!(options && options.silent);
  if (!meta || !projectId) { setStatus('请先导入视频并分帧'); return; }
  if (autoRunning) { setStatus('AI 自动打标运行中，请完成后再自动修正'); return; }
  if (qaDeepRunning) { setStatus('AI 深度质检运行中，请等待完成后再自动修正'); return; }
  const before = runQualityCheck(true);
  const totalIssues = before.errors + before.warnings;
  if (!totalIssues) { setStatus(silent ? 'AI 深度质检完成：未发现问题，无需修正' : '质检已通过，无需修正'); return; }
  const deepList = qaDeep.suggestions.slice();  // snapshot 会清空质检态，先取出深度建议
  const deepSplitCount = deepList.filter((s) => s.type === 'split').length;
  const deepTightenCount = deepList.filter((s) => s.type === 'tighten').length;
  const deepDropCount = deepList.filter((s) => s.type === 'empty').length;
  if (!silent) {
    const ok = confirm(
      `将对全部帧执行自动修正：\n` +
      `· 删除重复框和同帧重复 ID\n` +
      `· 按前一帧对比纠正 ID 跳变 / 串号 / 丢人换号\n` +
      `· 拉回单帧抖动、补全 3 帧以内短断层\n` +
      (deepSplitCount ? `· 拆分 ${deepSplitCount} 个框内多人框，并按前后帧对齐 ID\n` : '') +
      (deepTightenCount ? `· 收紧 ${deepTightenCount} 个不贴合框\n` : '') +
      (deepDropCount ? `· 删除 ${deepDropCount} 个框内非人框（含前后帧同 ID 的框）\n` : '') +
      `\n共 ${before.errors} 个错误、${before.warnings} 个提醒；修正可能调整部分框 ID，是否继续？`
    );
    if (!ok) return;
  }

  snapshot();
  let fixed = 0;
  let deepApplied = 0;
  let deepDroppedBoxes = 0;
  if (deepList.length) {
    const ctx = qaDeepContext();
    deepList.sort((a, b) => a.frame - b.frame);
    // 先删非人框（含前后帧同 ID），再拆分 / 收紧，避免拆分结果被误删
    for (const s of deepList) {
      if (s.type !== 'empty') continue;
      const n = qaDeepApplyDrop(s);
      if (n > 0) { deepDroppedBoxes += n; deepApplied++; }
    }
    for (const s of deepList) {
      if (s.type === 'split' && qaDeepApplySplit(s, ctx)) deepApplied++;
      else if (s.type === 'tighten' && qaDeepApplyTighten(s)) deepApplied++;
    }
    qaDeep.suggestions = [];
    qaDeep.summary = null;
    updateQaDeepUI();
    qaDeepSetMsg('AI 深度质检建议已全部应用。');
  }
  fixed += deepApplied;
  fixed += autoRemoveDuplicates();
  fixed += autoRepairSingleFrameSpikes();
  fixed += autoReconcileIds();
  fixed += autoRemoveDuplicates();
  fixed += autoFillShortGaps(3);
  if (deepList.length) deepDroppedBoxes += qaDeepCleanupDrops(deepList);

  selectedIndex = -1;
  hiddenIds.clear();
  overwriteIds.clear();
  stickyCheckedIds = [];
  refreshAll();
  save();
  const after = runQualityCheck(true);
  setStatus((silent ? 'AI 深度质检已自动修正' : '一键修正完成') + `：处理 ${fixed} 处` +
    (deepApplied ? `（含 AI 深度修正 ${deepApplied} 处` + (deepDroppedBoxes ? `，删除 ${deepDroppedBoxes} 个非人框` : '') + '）' : '') +
    `，剩余 ${after.errors} 个错误、${after.warnings} 个提醒`);
}

if (el.btnQaFix) {
  el.btnQaFix.addEventListener('click', () => { autoFixAllIssues(); });
}

if (el.btnQa) {
  el.btnQa.addEventListener('click', () => {
    if (!meta) { setStatus('请先导入视频并分帧'); return; }
    if (el.qaOverlap) {
      el.qaOverlap.value = String(qaOverlapThreshold());
      localStorage.setItem('anno_qaOverlap', String(qaOverlapThreshold()));
    }
    runQualityCheck(false);
  });
}
if (el.qaOverlap) {
  const savedThreshold = parseFloat(localStorage.getItem('anno_qaOverlap'));
  if (Number.isFinite(savedThreshold)) {
    el.qaOverlap.value = String(Math.max(0.3, Math.min(1, savedThreshold)));
  }
  el.qaOverlap.addEventListener('change', () => {
    el.qaOverlap.value = String(qaOverlapThreshold());
    localStorage.setItem('anno_qaOverlap', String(qaOverlapThreshold()));
    invalidateQa();
  });
}
resetQaState();

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
  normalizeBox(b);
  if (region.length >= 3 && !boxAllowedInRegion(b, region)) {
    alert(`按「${regionContainLabel()}」判定，该框不在划线区域内，已取消添加`);
    return;
  }
  snapshot();
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
  if (regionMode) {
    if (k === 'escape') { e.preventDefault(); cancelRegionDraw(); }
    else if (k === 'enter') { e.preventDefault(); finishRegionDraw(); }
    else if (k === 'backspace' || k === 'delete') {
      e.preventDefault();
      regionDraft.pop();
      regionCursor = null;
      draw();
    }
    return;
  }
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
  // 切换前先把旧项目尚未落盘的修改保存掉，避免写到新项目里
  if (!autoRunning && projectId && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { await doSave(); } catch (_) {}
  }

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
  region = normalizeRegion(data.region);
  regionContain = data.regionContain === 'full' ? 'full' : 'center';
  regionMode = false;
  regionDraft = [];
  regionCursor = null;
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
  resetQaState();
  resetQaDeepState(true);
  localStorage.setItem('anno_projectId', pid);
  markLastProject(pid);

  el.frameCountLabel.textContent = '/ ' + meta.count;
  el.frameIndex.value = currentFrame;
  // 导入的数据集没有原视频，不允许重新分帧（会覆盖已还原的帧）
  el.btnExtract.disabled = !!meta.imported;
  el.btnExtract.title = meta.imported ? '导入的数据集没有原视频，无法重新分帧；可直接审查、修改和导出' : '';
  el.btnExport.disabled = false;
  setSaveState(false);
  resetAutoForProject();
  rebuildThumbs();
  refreshAll();
  loadFrame();
  runQualityCheck(true);
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
  region = []; regionContain = 'center'; regionMode = false; regionDraft = []; regionCursor = null;
  stickyCheckedIds = [];
  hiddenIds.clear();
  overwriteIds.clear();
  currentFrame = 1;
  selectedIndex = -1;
  undoStack = [];
  drag = null;
  resetQaState();
  resetQaDeepState(true);
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
  minArea: $('autoMinArea'), mode: $('autoMode'), range: $('autoRange'),
  scope: $('autoScope'), scopeTip: $('autoScopeTip'), msg: $('autoMsg'),
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

// 标注范围：与工具栏「区域判定」同一个规则，AI 只在划线区域内推理
function updateAutoScopeUI() {
  if (!autoEl.scope) return;
  const hasRegion = region.length >= 3;
  autoEl.scope.value = regionContain === 'full' ? 'full' : 'center';
  autoEl.scope.disabled = !!autoRunning;
  if (autoEl.scopeTip) {
    autoEl.scopeTip.textContent = hasRegion
      ? '只在划线区域内推理；' + regionContainLabel()
      : '未划线：请先在画布上划区域，再开始自动打标';
    autoEl.scopeTip.classList.toggle('warn', !hasRegion);
  }
}

if (autoEl.scope) {
  autoEl.scope.addEventListener('change', () => {
    const next = autoEl.scope.value === 'full' ? 'full' : 'center';
    if (next === regionContain) return;
    regionContain = next;
    if (el.regionContain) el.regionContain.value = next;
    save();
    updateRegionUI();
    updateAutoScopeUI();
    setStatus('区域判定方式已切换为「' + regionContainLabel() + '」，仅影响之后的新框 / AI 结果');
  });
}

function openAutoModal() {
  if (!autoEl.modal || !projectId || !meta) return;
  setAutoMsg('');
  updateAutoScopeUI();
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
  if (region.length < 3) {
    setAutoMsg('请先在画布上划线：AI 只在划线区域内推理（区域判定：' + regionContainLabel() + '）');
    return;
  }
  const scope = 'region';
  const regionRule = autoEl.scope && autoEl.scope.value === 'full' ? 'full' : 'center';
  if (regionRule !== regionContain) {
    regionContain = regionRule;
    if (el.regionContain) el.regionContain.value = regionRule;
    updateRegionUI();
  }
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
        projectId: submitPid, prompt, minScore, minArea, mode, startFrame, count,
        scope, regionContain: regionRule
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
      const qa = runQualityCheck(true);
      showAutoResultDone(job);
      if (qa.errors || qa.warnings) {
        autoEl.resultMsg.textContent =
          '结果已写入当前项目。质检发现 ' + qa.errors + ' 个错误、' + qa.warnings +
          ' 个提醒，可在右侧「标注质检」直接定位修正。';
        setStatus('AI 自动打标完成：' + autoResultSummary(job && job.result) +
          '；质检发现 ' + (qa.errors + qa.warnings) + ' 个问题');
      } else {
        autoEl.resultMsg.textContent = '结果已写入当前项目，质检通过，可直接导出或人工微调。';
        setStatus('AI 自动打标完成：' + autoResultSummary(job && job.result) + '；质检通过');
      }
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
