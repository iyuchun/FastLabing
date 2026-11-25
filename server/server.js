'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn, exec } = require('child_process');
const { extractFrames } = require('./extract');
const { exportDataset } = require('./export');
const { importDatasetZip } = require('./import');

const { ROOT, STORAGE, FRAMES_DIR, PROJECTS_DIR, UPLOAD_DIR, EXPORT_DIR, ZIP_DIR, TMP_DIR } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

for (const d of [UPLOAD_DIR, FRAMES_DIR, PROJECTS_DIR, EXPORT_DIR, ZIP_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/frames', express.static(FRAMES_DIR));

function genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.projectId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
    cb(null, 'video' + ext);
  }
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

// 上传视频
app.post('/api/upload', (req, res, next) => {
  req.projectId = genId();
  next();
}, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到视频文件' });
  // busboy/multer 会把非 ASCII 文件名按 latin1 解码，这里转回 UTF-8
  let originalName = req.file.originalname || '';
  try { originalName = Buffer.from(originalName, 'latin1').toString('utf8'); } catch (_) {}
  res.json({ projectId: req.projectId, originalName, size: req.file.size });
});

// 导入别人导出的数据集 ZIP（COCO 格式，可加密），还原为项目
const datasetUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(TMP_DIR, 'imports');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'dataset-' + genId() + '.zip')
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }
});

app.post('/api/import-dataset', datasetUpload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到数据集压缩包' });
  let originalName = req.file.originalname || '';
  try { originalName = Buffer.from(originalName, 'latin1').toString('utf8'); } catch (_) {}

  try {
    const result = await importDatasetZip(req.file.path, {
      password: req.body.password,
      name: req.body.name,
      originalName
    });
    if (result.name) {
      const map = readProjectMeta();
      map[result.projectId] = { ...(map[result.projectId] || {}), name: result.name };
      writeProjectMeta(map);
    }
    res.json(result);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  } finally {
    try { fs.rmSync(req.file.path, { force: true }); } catch (_) {}
  }
});

// 分帧
app.post('/api/extract', async (req, res) => {
  try {
    const { projectId, fps } = req.body || {};
    if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
    const f = Number(fps);
    if (!f || f <= 0 || f > 120) return res.status(400).json({ error: 'FPS 无效（应为 1~120）' });
    const videoDir = path.join(UPLOAD_DIR, projectId);
    if (!fs.existsSync(videoDir)) return res.status(400).json({ error: '未找到上传的视频，请重新导入' });
    const videoFile = fs.readdirSync(videoDir).find((n) => /^video\./i.test(n));
    if (!videoFile) return res.status(400).json({ error: '未找到上传的视频，请重新导入' });
    const meta = await extractFrames(path.join(videoDir, videoFile), projectId, f);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 读标注
app.get('/api/project/:projectId', (req, res) => {
  const p = path.join(PROJECTS_DIR, req.params.projectId + '.json');
  const folder = path.join(FRAMES_DIR, req.params.projectId);
  if (!fs.existsSync(p)) return res.json({ annotations: {}, categoryName: 'object', folder });
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.json({ ...data, folder });
  }
  catch (e) { res.json({ annotations: {}, categoryName: 'object', folder }); }
});

// 存标注
app.post('/api/project/:projectId', (req, res) => {
  try {
    const p = path.join(PROJECTS_DIR, req.params.projectId + '.json');
    fs.writeFileSync(p, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 导出
app.post('/api/export', async (req, res) => {
  try {
    const { projectId, categoryName } = req.body || {};
    if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
    const result = await exportDataset(projectId, categoryName);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 下载加密 zip
app.get('/api/download/:file', (req, res) => {
  const f = path.basename(req.params.file);
  const p = path.join(ZIP_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' });
  res.download(p, f);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ===================== 项目管理（列出 / 记录上次项目 / 增删改查） =====================
const LAST_PROJECT_FILE = path.join(STORAGE, 'last-project.json');
const PROJECT_META_FILE = path.join(STORAGE, 'project-meta.json');

function readLastProjectId() {
  try { return JSON.parse(fs.readFileSync(LAST_PROJECT_FILE, 'utf8')).projectId || null; }
  catch (_) { return null; }
}

// 项目显示名单独存放，避免被标注文件覆盖
function readProjectMeta() {
  try { return JSON.parse(fs.readFileSync(PROJECT_META_FILE, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function writeProjectMeta(data) {
  fs.writeFileSync(PROJECT_META_FILE, JSON.stringify(data, null, 2));
}

// 列出 storage/frames 下所有已完成分帧的项目，附带标注进度
app.get('/api/projects', (req, res) => {
  const list = [];
  const metaByName = readProjectMeta();
  let names = [];
  try { names = fs.readdirSync(FRAMES_DIR); } catch (_) {}

  for (const name of names) {
    try {
      const dir = path.join(FRAMES_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      let annotatedFrames = 0;
      let totalBoxes = 0;
      let categoryName = 'object';
      let updatedAt = fs.statSync(metaPath).mtimeMs;

      const projPath = path.join(PROJECTS_DIR, name + '.json');
      if (fs.existsSync(projPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(projPath, 'utf8'));
          const ann = data.annotations || {};
          for (const k in ann) {
            const arr = ann[k] || [];
            if (arr.length) { annotatedFrames++; totalBoxes += arr.length; }
          }
          if (data.categoryName) categoryName = data.categoryName;
          updatedAt = Math.max(updatedAt, fs.statSync(projPath).mtimeMs);
        } catch (_) {}
      }

      list.push({
        id: name,
        name: (metaByName[name] && metaByName[name].name) || '',
        frames: Number(meta.count) || 0,
        fps: Number(meta.fps) || null,
        width: Number(meta.width) || null,
        height: Number(meta.height) || null,
        thumb: (meta.thumbs && meta.thumbs[0]) || (meta.files && meta.files[0]) || null,
        annotatedFrames,
        totalBoxes,
        categoryName,
        updatedAt
      });
    } catch (_) {}
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ projects: list, lastProjectId: readLastProjectId() });
});

// 记录最近打开的项目（服务重启后自动恢复）
app.post('/api/last-project', (req, res) => {
  const projectId = String((req.body || {}).projectId || '');
  if (!/^[\w.-]+$/.test(projectId)) return res.status(400).json({ error: 'projectId 无效' });
  if (!fs.existsSync(path.join(FRAMES_DIR, projectId, 'meta.json'))) {
    return res.status(404).json({ error: '项目不存在或尚未分帧' });
  }
  try {
    fs.writeFileSync(LAST_PROJECT_FILE, JSON.stringify({ projectId }, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 项目重命名（只改显示名，不动数据）
app.post('/api/projects/:projectId/rename', (req, res) => {
  const id = String(req.params.projectId || '');
  if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'projectId 无效' });
  if (!fs.existsSync(path.join(FRAMES_DIR, id, 'meta.json'))) {
    return res.status(404).json({ error: '项目不存在' });
  }
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  try {
    const map = readProjectMeta();
    if (name) map[id] = { ...(map[id] || {}), name };
    else delete map[id];
    writeProjectMeta(map);
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 在资源管理器中打开项目文件夹
app.post('/api/projects/:projectId/open-folder', (req, res) => {
  const id = String(req.params.projectId || '');
  if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'projectId 无效' });
  const dir = path.join(FRAMES_DIR, id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: '项目文件夹不存在' });
  try {
    const proc = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true });
    proc.unref();
    res.json({ ok: true, path: dir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除项目：帧图片、标注、上传视频、导出文件一并清理
app.delete('/api/projects/:projectId', (req, res) => {
  const id = String(req.params.projectId || '');
  if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'projectId 无效' });
  if (!fs.existsSync(path.join(FRAMES_DIR, id, 'meta.json'))) {
    return res.status(404).json({ error: '项目不存在' });
  }
  try {
    fs.rmSync(path.join(FRAMES_DIR, id), { recursive: true, force: true });
    fs.rmSync(path.join(PROJECTS_DIR, id + '.json'), { force: true });
    fs.rmSync(path.join(UPLOAD_DIR, id), { recursive: true, force: true });
    fs.rmSync(path.join(EXPORT_DIR, id), { recursive: true, force: true });
    try {
      for (const f of fs.readdirSync(ZIP_DIR)) {
        if (f.startsWith('数据集_' + id + '_')) fs.rmSync(path.join(ZIP_DIR, f), { force: true });
      }
    } catch (_) {}

    const map = readProjectMeta();
    if (map[id]) { delete map[id]; writeProjectMeta(map); }
    if (readLastProjectId() === id) fs.rmSync(LAST_PROJECT_FILE, { force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GPU 实时监控（nvidia-smi），无 GPU 时返回 null
let gpuCache = { t: 0, data: null };
app.get('/api/gpu', (req, res) => {
  if (Date.now() - gpuCache.t < 1000 && gpuCache.data) return res.json(gpuCache.data);
  exec('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
    { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        gpuCache = { t: Date.now(), data: { gpu: null } };
        return res.json(gpuCache.data);
      }
      const [name, util, memUsed, memTotal, temp] = stdout.trim().split(',').map((s) => s.trim());
      gpuCache = {
        t: Date.now(),
        data: {
          gpu: {
            name,
            utilization: Number(util),
            memoryUsed: Number(memUsed),
            memoryTotal: Number(memTotal),
            temperature: Number(temp)
          }
        }
      };
      res.json(gpuCache.data);
    });
});

// ===================== 视频跟踪（SAM 3 / SAM 2.1） =====================
const SAM3_REPO = process.env.SAM3_REPO || path.join(ROOT, 'third_party', 'sam3');
const SAM2_ROOT = process.env.SAM2_ROOT || '';
const SAM2_CKPT = process.env.SAM2_CKPT || path.join(ROOT, 'models', 'sam2.1_hiera_tiny.pt');
const SAM2_CONFIG = process.env.SAM2_CONFIG || 'configs/sam2.1/sam2.1_hiera_t.yaml';
const SAM3_CKPT = process.env.SAM3_CKPT || path.join(ROOT, 'models', 'sam3.pt');

// Python 解析：环境变量 PYTHON → 程序自带 .venv → PATH 中的 python
function findOnPath(exe) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const VENV_PYTHON = path.join(ROOT, '.venv', 'Scripts', 'python.exe');

function resolvePython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  candidates.push(VENV_PYTHON);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return { path: p, source: 'file' }; } catch (_) {}
  }
  const onPath = findOnPath('python.exe');
  if (onPath) return { path: onPath, source: 'path' };
  return { path: 'python', source: 'missing' };
}

const PYTHON_RESOLVED = resolvePython();
const PYTHON = PYTHON_RESOLVED.path;

// 给所有 SAM 子进程统一注入的环境变量
function samChildEnv() {
  return {
    ...process.env,
    PYTHONPATH: [SAM3_REPO, SAM2_ROOT].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    KMP_DUPLICATE_LIB_OK: process.env.KMP_DUPLICATE_LIB_OK || 'TRUE',
    SAM3_REPO,
    SAM3_CKPT,
    SAM2_ROOT,
    SAM2_CKPT,
    SAM2_CONFIG,
    SAM2_TMP_DIR: TMP_DIR
  };
}

const jobs = new Map();      // jobId -> { status, progress, total, message, result, error, backend }
const pending = new Map();   // reqId -> jobId
const workers = new Map();   // backend -> { proc, rl }
let reqSeq = 0;

function failJobsByBackend(backend, message) {
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.backend === backend) {
      job.status = 'error';
      job.error = message;
    }
  }
  for (const [reqId, jobId] of Array.from(pending.entries())) {
    const j = jobs.get(jobId);
    if (!j || j.backend === backend) pending.delete(reqId);
  }
}

function stopWorker(backend) {
  const entry = workers.get(backend);
  if (!entry) return;
  workers.delete(backend);
  try { entry.rl.close(); } catch (_) {}
  try { entry.proc.kill(); } catch (_) {}
  failJobsByBackend(backend, (backend === 'sam2' ? 'SAM 2.1' : 'SAM 3') + ' 进程已停止');
}

function startWorker(backend) {
  if (workers.has(backend)) return workers.get(backend);

  // 8G 显存：同一时间只保留一个模型进程，切换模型时释放另一个
  for (const key of Array.from(workers.keys())) {
    if (key !== backend) stopWorker(key);
  }

  const isSam2 = backend === 'sam2';
  const script = path.join(__dirname, isSam2 ? 'sam2_worker.py' : 'sam3_worker.py');
  const proc = spawn(PYTHON, ['-u', script], {
    cwd: ROOT,
    env: samChildEnv(),
    windowsHide: true
  });

  const rl = readline.createInterface({ input: proc.stdout });
  const entry = { proc, rl };
  workers.set(backend, entry);
  const label = isSam2 ? 'SAM 2.1' : 'SAM 3';

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }  // 忽略模型日志
    const job = msg.reqId != null ? jobs.get(pending.get(msg.reqId)) : null;
    if (msg.type === 'status' || msg.type === 'ready') {
      for (const j of jobs.values()) {
        if (j.status === 'running' && j.backend === backend) j.message = msg.message || j.message;
      }
    } else if (msg.type === 'progress' && job) {
      job.progress = msg.done;
      job.total = msg.total;
    } else if (msg.type === 'result' && job) {
      job.status = 'done';
      job.result = msg.boxes || [];
      job.promptObjId = msg.promptObjId;
      pending.delete(msg.reqId);
    } else if (msg.type === 'error' && job) {
      job.status = 'error';
      job.error = msg.message || '跟踪失败';
      pending.delete(msg.reqId);
    }
  });

  proc.stderr.on('data', (buf) => {
    if (process.env.SAM3_DEBUG === '1') process.stderr.write(buf);
  });

  proc.on('error', (err) => {
    workers.delete(backend);
    failJobsByBackend(backend, label + ' 启动失败：' + err.message);
  });

  proc.on('exit', (code) => {
    const cur = workers.get(backend);
    if (cur && cur.proc === proc) workers.delete(backend);
    try { rl.close(); } catch (_) {}
    failJobsByBackend(backend, label + ' 进程已退出（code=' + code + '）');
    for (const j of jobs.values()) {
      if (j.status === 'running' && j.backend === backend) j.message = label + ' 进程已退出';
    }
  });

  return entry;
}

// 提交跟踪任务
app.post('/api/track', (req, res) => {
  try {
    if (autoJobRunning()) {
      return res.status(409).json({ error: 'AI 自动打标正在运行，请等待完成或取消后再使用智能跟踪' });
    }
    const { projectId, startFrame, count, box, id, model, precision, fillMissing } = req.body || {};
    if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
    if (!box || !(box.w > 0) || !(box.h > 0)) return res.status(400).json({ error: '提示框无效' });

    const backend = model === 'sam2' ? 'sam2' : 'sam3';
    // SAM3 精度档位：精细=逐帧，快速=隔1帧，极速=隔2帧（后端插值补齐）
    const strideMap = { high: 1, fast: 2, turbo: 3 };
    const stride = backend === 'sam2' ? 1 : (strideMap[precision] || 1);

    const framesDir = path.join(FRAMES_DIR, projectId);
    const metaPath = path.join(framesDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return res.status(400).json({ error: '该视频尚未分帧' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    const start = Math.max(1, Math.round(Number(startFrame) || 1));
    const total = Math.max(1, Math.round(Number(count) || 30));

    const jobId = 'track-' + genId();
    jobs.set(jobId, {
      status: 'running', progress: 0, total,
      backend,
      message: backend === 'sam2'
        ? '正在启动 SAM 2.1（首次加载约 3 秒）…'
        : '正在启动 SAM 3（首次加载模型约 20 秒）…',
      result: null, error: null, startFrame: start
    });

    const entry = startWorker(backend);
    const reqId = ++reqSeq;
    pending.set(reqId, jobId);
    entry.proc.stdin.write(JSON.stringify({
      type: 'track', reqId,
      framesDir,
      startFrame: start,
      count: Math.min(total, Math.max(1, (meta.count || 1) - start + 1)),
      totalFrames: meta.count || 0,
      box: { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) },
      id: Number(id) || 1,
      stride,
      fillMissing: fillMissing !== false
    }) + '\n');

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 查询跟踪任务
app.get('/api/track/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

// ===================== AI 自动打标（SAM 3 文本提示：自动检测 + 跨帧跟踪） =====================
const AUTO_WORKER = path.join(__dirname, 'auto_worker.py');
const AUTO_IMAGE_WORKER = path.join(__dirname, 'auto_worker_image.py');
const BACKUP_DIR = path.join(STORAGE, 'backups');
// 长视频/拥挤场景用「逐帧图像检测 + IoU 追踪」后端更稳（内存恒定）；
// 短视频用视频跟踪器后端（跨帧连续性更好）。可用环境变量 AUTO_BACKEND=image|video 强制。
const AUTO_IMAGE_MIN_FRAMES = 240;

const autoJobs = new Map();   // jobId -> job
let currentAutoJobId = null;

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function autoCapability() {
  const py = PYTHON_RESOLVED;
  const problems = [];
  if (!fs.existsSync(AUTO_WORKER)) problems.push('缺少自动打标 worker（server/auto_worker.py）');
  if (py.source === 'missing') problems.push('未找到可用的 Python 环境');
  if (!fs.existsSync(SAM3_CKPT)) problems.push('未找到 SAM 3 权重（' + SAM3_CKPT + '）');
  return {
    available: problems.length === 0,
    backend: 'sam3',
    imageBackend: fs.existsSync(AUTO_IMAGE_WORKER),
    imageMinFrames: AUTO_IMAGE_MIN_FRAMES,
    python: py.path,
    pythonSource: py.source,
    prompt: 'person',
    reason: problems.join('；')
  };
}

function autoJobRunning() {
  if (!currentAutoJobId) return false;
  const job = autoJobs.get(currentAutoJobId);
  return !!(job && job.status === 'running');
}

function publicAutoJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    total: job.total,
    found: job.found,
    message: job.message,
    projectId: job.projectId,
    backend: job.backend || 'video',
    mode: job.mode,
    startFrame: job.startFrame,
    count: job.count,
    prompt: job.prompt,
    result: job.result,
    error: job.error,
    elapsed: Date.now() - job.createdAt
  };
}

function pruneAutoJobs() {
  for (const [id, job] of Array.from(autoJobs.entries())) {
    if (job.status !== 'running' && Date.now() - job.createdAt > 6 * 60 * 60 * 1000) autoJobs.delete(id);
  }
  while (autoJobs.size > 30) {
    const first = autoJobs.keys().next().value;
    if (!first || (autoJobs.get(first) || {}).status === 'running') break;
    autoJobs.delete(first);
  }
}

function failAutoJob(job, message) {
  if (job.status !== 'running') return;
  job.status = 'error';
  job.error = message;
  job.message = message;
  if (job.timer) { clearTimeout(job.timer); job.timer = null; }
  try { if (job.proc) job.proc.kill(); } catch (_) {}
}

// 判断框是否完全位于划线区域内（自动打标结果过滤用）
function pointOnSegment(p, a, b) {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 0.5) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < -0.5) return false;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= len2 + 0.5;
}

function pointInPolygon(p, poly) {
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

// 框的边缘在区域内：四个角都在区域内，且没有区域边穿过框
function boxFullyInsidePolygon(b, poly) {
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
function boxCenterInPolygon(b, poly) {
  if (!poly || poly.length < 3) return true;
  const x1 = Math.min(b.x, b.x + b.w), x2 = Math.max(b.x, b.x + b.w);
  const y1 = Math.min(b.y, b.y + b.h), y2 = Math.max(b.y, b.y + b.h);
  if (!(x2 > x1) || !(y2 > y1)) return false;
  return pointInPolygon({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, poly);
}

// 按判定方式过滤：center=中心点在区域内；full=框边缘在区域内
function boxAllowedInPolygon(b, poly, mode) {
  if (!poly || poly.length < 3) return true;
  return mode === 'full' ? boxFullyInsidePolygon(b, poly) : boxCenterInPolygon(b, poly);
}

// 划线区域的外接矩形：把 AI 推理裁剪到该范围（带少量留边，避免切掉边缘目标）
function regionBBox(poly, W, H, padRatio) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of poly) {
    const x = Number(p && p.x), y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || x2 <= x1 || y2 <= y1) return null;
  const padX = Math.max(8, (x2 - x1) * (padRatio || 0.03));
  const padY = Math.max(8, (y2 - y1) * (padRatio || 0.03));
  x1 = Math.max(0, Math.floor(x1 - padX));
  y1 = Math.max(0, Math.floor(y1 - padY));
  x2 = Math.ceil(x2 + padX);
  y2 = Math.ceil(y2 + padY);
  if (W > 0) x2 = Math.min(W, x2);
  if (H > 0) y2 = Math.min(H, y2);
  const w = Math.round(x2 - x1), h = Math.round(y2 - y1);
  if (w < 32 || h < 32) return null;
  return { x: Math.round(x1), y: Math.round(y1), w, h };
}

// 把自动打标结果按覆盖策略合并进项目标注文件（写前备份）
function mergeAutoAnnotations(job, data) {
  const projPath = path.join(PROJECTS_DIR, job.projectId + '.json');
  let proj = { annotations: {}, categoryName: 'object' };
  if (fs.existsSync(projPath)) {
    try { proj = JSON.parse(fs.readFileSync(projPath, 'utf8')) || proj; } catch (_) {}
  }
  if (!proj.annotations || typeof proj.annotations !== 'object') proj.annotations = {};
  const ann = proj.annotations;
  const region = (Array.isArray(proj.region) ? proj.region : [])
    .map((p) => ({ x: Number(p && p.x), y: Number(p && p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const regionContain = job.regionContain
    ? (job.regionContain === 'full' ? 'full' : 'center')
    : (proj.regionContain === 'full' ? 'full' : 'center');

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(projPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(projPath, path.join(BACKUP_DIR, job.projectId + '_' + stamp + '.json'));
  }

  let W = 0, H = 0;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, job.projectId, 'meta.json'), 'utf8'));
    W = Number(m.width) || 0; H = Number(m.height) || 0;
  } catch (_) {}

  let baseId = 0;
  if (job.mode === 'append') {
    for (const k in ann) for (const b of (ann[k] || [])) baseId = Math.max(baseId, Number(b.id) || 0);
  }

  const frames = Array.isArray(data.frames) ? data.frames : [];
  const seenRawIds = new Set();
  let boxCount = 0, frameCount = 0;

  for (const item of frames) {
    const f = Math.round(Number(item && item.frame));
    if (!(f >= 1)) continue;
    const key = String(f);
    const src = Array.isArray(item.boxes) ? item.boxes : [];
    const boxes = [];
    for (const b of src) {
      let x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      if (w <= 1 || h <= 1) continue;
      if (W > 0) { x = Math.max(0, Math.min(x, W - 2)); w = Math.min(w, W - x); }
      if (H > 0) { y = Math.max(0, Math.min(y, H - 2)); h = Math.min(h, H - y); }
      if (w < 2 || h < 2) continue;
      if (region.length >= 3 && !boxAllowedInPolygon({ x, y, w, h }, region, regionContain)) continue;
      const rawId = Math.round(Number(b.id) || 0);
      seenRawIds.add(rawId);
      let id = job.mode === 'append' ? rawId + baseId : rawId;
      if (!(id >= 1)) id = 1;
      boxes.push({ id, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    }

    if (job.mode === 'replace') {
      ann[key] = boxes;
    } else if (job.mode === 'fill') {
      if (!Array.isArray(ann[key]) || ann[key].length === 0) ann[key] = boxes;
    } else {
      ann[key] = (Array.isArray(ann[key]) ? ann[key] : []).concat(boxes);
    }
    frameCount++;
    boxCount += boxes.length;
  }

  proj.annotations = ann;
  fs.writeFileSync(projPath, JSON.stringify(proj, null, 2));
  return { frameCount, boxCount, objectCount: seenRawIds.size, mode: job.mode, projectId: job.projectId };
}

function finishAutoJob(job, msg) {
  if (job.status !== 'running') return;
  if (job.timer) { clearTimeout(job.timer); job.timer = null; }
  try {
    const outPath = msg.outPath || job.outPath;
    if (!outPath || !fs.existsSync(outPath)) throw new Error('未生成结果文件');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    job.result = mergeAutoAnnotations(job, data);
    job.status = 'done';
    job.progress = job.total;
    job.found = job.result.objectCount;
    job.message = '自动打标完成';
  } catch (e) {
    job.status = 'error';
    job.error = '结果写入失败：' + e.message;
    job.message = job.error;
  }
}

// 可用性检测：前端据此决定「AI 自动打标」按钮是否可用
app.get('/api/auto/capability', (req, res) => {
  res.json(autoCapability());
});

// 当前（最近一次）自动打标任务，用于刷新页面后恢复运行中的进度
app.get('/api/auto/current', (req, res) => {
  const job = currentAutoJobId ? autoJobs.get(currentAutoJobId) : null;
  res.json({ job: publicAutoJob(job) });
});

// 启动自动打标任务
app.post('/api/auto', (req, res) => {
  try {
    const body = req.body || {};
    const projectId = String(body.projectId || '');
    if (!/^[\w.-]+$/.test(projectId)) return res.status(400).json({ error: 'projectId 无效' });
    if (autoJobRunning()) return res.status(409).json({ error: '已有 AI 自动打标任务在运行，请等待完成或取消' });
    if (Array.from(jobs.values()).some((j) => j.status === 'running')) {
      return res.status(409).json({ error: '智能跟踪任务正在运行，请等待完成后再自动打标' });
    }

    const cap = autoCapability();
    if (!cap.available) return res.status(503).json({ error: 'AI 自动打标不可用：' + cap.reason });

    const framesDir = path.join(FRAMES_DIR, projectId);
    const metaPath = path.join(framesDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return res.status(400).json({ error: '该项目尚未分帧，请先分帧' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const totalFrames = Number(meta.count) || 0;
    if (totalFrames < 1) return res.status(400).json({ error: '该项目没有可用帧' });

    const startFrame = Math.max(1, Math.min(totalFrames, Math.round(Number(body.startFrame) || 1)));
    const maxCount = totalFrames - startFrame + 1;
    const count = Math.max(1, Math.min(maxCount, Math.round(Number(body.count) || maxCount)));

    const prompt = String(body.prompt || 'person').trim().slice(0, 60) || 'person';
    const minScore = clampNum(body.minScore, 0.05, 0.95, 0.5);
    // 前端契约：minArea 单位是「占整幅画面的百分比」（默认 0.05%）；worker 内部用比例（0.0005）。
    const minAreaPct = clampNum(body.minArea, 0.001, 10, 0.05);
    const minArea = minAreaPct / 100;
    const mode = ['replace', 'fill', 'append'].includes(body.mode) ? body.mode : 'replace';

    // 标注范围：只在划线区域内推理；区域判定二选一：
    // center = 框中心点在区域内，full = 框边缘（整框）在区域内
    const scope = 'region';
    const regionContain = body.regionContain === 'full' ? 'full' : 'center';
    let poly = [];
    try {
      const projPath = path.join(PROJECTS_DIR, projectId + '.json');
      if (fs.existsSync(projPath)) {
        const proj = JSON.parse(fs.readFileSync(projPath, 'utf8')) || {};
        poly = Array.isArray(proj.region) ? proj.region : [];
      }
    } catch (_) {}
    const crop = regionBBox(poly, Number(meta.width) || 0, Number(meta.height) || 0, 0.03);
    if (!crop) {
      return res.status(400).json({ error: '当前项目没有可用的划线区域：请先在画布上划一个闭合区域，再自动打标' });
    }

    // 后端选择：默认走「图像检测 + IoU 追踪」后端（内存恒定、长视频稳定、速度可预测）；
    // 设置环境变量 AUTO_BACKEND=video 可强制使用 SAM3 视频跟踪器后端（短视频连续性更好）。
    const backendEnv = String(process.env.AUTO_BACKEND || '').toLowerCase();
    const useImageBackend = fs.existsSync(AUTO_IMAGE_WORKER) && backendEnv !== 'video';
    const workerScript = useImageBackend ? AUTO_IMAGE_WORKER : AUTO_WORKER;

    // 自动打标和智能跟踪共用 GPU：先停掉已有的跟踪 worker，避免显存不足
    for (const key of Array.from(workers.keys())) stopWorker(key);

    pruneAutoJobs();
    const jobId = 'auto-' + genId();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outPath = path.join(TMP_DIR, jobId + '.json');
    const reqId = ++reqSeq;

    const job = {
      jobId, status: 'running', progress: 0, total: count, found: 0,
      backend: useImageBackend ? 'image' : 'video',
      message: useImageBackend
        ? '正在启动 SAM 3 图像检测模式（长视频，约 10 秒加载）…'
        : '正在启动 SAM 3（首次加载模型约 20~60 秒）…',
      result: null, error: null,
      projectId, mode, startFrame, count, prompt, scope, crop, regionContain,
      createdAt: Date.now(), proc: null, outPath, stderr: ''
    };
    autoJobs.set(jobId, job);
    currentAutoJobId = jobId;

    const proc = spawn(PYTHON, ['-u', workerScript], {
      cwd: ROOT,
      env: samChildEnv(),
      windowsHide: true
    });
    job.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    let sentRequest = false;

    const sendRequest = () => {
      if (sentRequest) return;
      sentRequest = true;
      try {
        proc.stdin.write(JSON.stringify({
          type: 'auto', reqId,
          framesDir, startFrame, count, totalFrames,
          prompt, stride: 1, minScore, minArea, maxObjects: 200,
          crop, outPath
        }) + '\n');
      } catch (e) {
        failAutoJob(job, '无法向 worker 发送任务：' + e.message);
      }
    };

    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (msg.type === 'ready') sendRequest();
      else if (msg.type === 'status') job.message = msg.message || job.message;
      else if (msg.type === 'progress') {
        job.progress = Number(msg.done) || job.progress;
        if (msg.total) job.total = Number(msg.total) || job.total;
        if (msg.found != null) job.found = Number(msg.found) || 0;
      } else if (msg.type === 'result') finishAutoJob(job, msg);
      else if (msg.type === 'error') failAutoJob(job, msg.message || '自动打标失败');
    });

    proc.stderr.on('data', (buf) => {
      job.stderr = (job.stderr + buf.toString()).slice(-6000);
    });
    proc.on('error', (err) => failAutoJob(job, '无法启动 Python（' + PYTHON + '）：' + err.message));
    proc.on('close', (code) => {
      try { rl.close(); } catch (_) {}
      if (job.status === 'running') {
        const tail = job.stderr ? '：' + job.stderr.slice(-400).replace(/\s+/g, ' ') : '';
        failAutoJob(job, '自动打标进程已退出（code=' + code + '）' + tail);
      }
      job.proc = null;
    });

    // 兜底：worker 卡死时不让任务永远 running
    job.timer = setTimeout(() => {
      if (job.status !== 'running') return;
      try { proc.kill(); } catch (_) {}
      failAutoJob(job, '自动打标超时（超过 3 小时）');
    }, 3 * 60 * 60 * 1000);

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 查询自动打标任务
app.get('/api/auto/:jobId', (req, res) => {
  const job = autoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(publicAutoJob(job));
});

// 取消自动打标任务
app.post('/api/auto/:jobId/cancel', (req, res) => {
  const job = autoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.message = '已取消';
    job.result = null;
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    try { if (job.proc) job.proc.kill(); } catch (_) {}
  }
  res.json({ ok: true, status: job.status });
});

// ===================== AI 深度质检（框内多人 / 框贴合度） =====================
const qualityJobs = new Map();
let currentQualityJobId = null;

function qualityJobRunning() {
  for (const job of qualityJobs.values()) if (job.status === 'running') return true;
  return false;
}

function pruneQualityJobs() {
  for (const [id, job] of Array.from(qualityJobs.entries())) {
    if (job.status !== 'running' && Date.now() - job.createdAt > 6 * 60 * 60 * 1000) qualityJobs.delete(id);
  }
  while (qualityJobs.size > 20) {
    const first = qualityJobs.keys().next().value;
    if (!first || (qualityJobs.get(first) || {}).status === 'running') break;
    qualityJobs.delete(first);
  }
}

function failQualityJob(job, message) {
  if (job.status !== 'running') return;
  job.status = 'error';
  job.error = message;
  job.message = message;
  if (job.timer) { clearTimeout(job.timer); job.timer = null; }
  try { if (job.proc) job.proc.kill(); } catch (_) {}
}

// 看门狗：只要 worker 持续有进度 / 状态输出就不断续期；超过 15 分钟无输出才判定卡死
const QUALITY_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
function touchQualityJob(job) {
  if (!job || job.status !== 'running') return;
  if (job.timer) clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    if (job.status !== 'running') return;
    try { if (job.proc) job.proc.kill(); } catch (_) {}
    failQualityJob(job, '深度质检超时：连续 15 分钟没有新进度（进程可能卡死），请重试或检查显卡环境');
  }, QUALITY_IDLE_TIMEOUT_MS);
}

function publicQualityJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    total: job.total,
    message: job.message,
    error: job.error,
    summary: job.summary || null,
    suggestions: job.suggestions || null,
    startFrame: job.startFrame,
    count: job.count,
    elapsed: Date.now() - job.createdAt
  };
}

function qBoxArea(b) { return Math.max(0, Number(b.w) || 0) * Math.max(0, Number(b.h) || 0); }

function qBoxInter(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 0 && iy > 0 ? ix * iy : 0;
}

function qBoxIou(a, b) {
  const inter = qBoxInter(a, b);
  if (!inter) return 0;
  const union = qBoxArea(a) + qBoxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

// 对比 AI 检测结果与现有标注：框内多人 → 拆分；框明显偏大/不贴合 → 收紧
function buildQualitySuggestions(ann, detFrames, startFrame, count) {
  const detByFrame = new Map();
  for (const item of detFrames || []) {
    const f = Math.round(Number(item && item.frame));
    if (!(f >= 1)) continue;
    const list = Array.isArray(item.boxes) ? item.boxes : [];
    const boxes = [];
    for (const b of list) {
      const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
      if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8) continue;
      boxes.push({ id: Math.round(Number(b.id) || 0), x, y, w, h });
    }
    detByFrame.set(f, boxes);
  }

  const endFrame = startFrame + count - 1;
  const suggestions = [];
  const counts = { split: 0, tighten: 0, empty: 0, checkedBoxes: 0, checkedFrames: 0 };

  for (const key in ann) {
    const frame = Math.round(Number(key));
    if (!(frame >= startFrame && frame <= endFrame)) continue;
    const boxes = Array.isArray(ann[key]) ? ann[key] : [];
    if (!boxes.length) continue;
    if (!detByFrame.has(frame)) continue;  // 该帧没有被扫描（只扫有标注的帧），跳过
    counts.checkedFrames++;
    const dets = detByFrame.get(frame);

    for (let idx = 0; idx < boxes.length; idx++) {
      const box = boxes[idx];
      const bArea = qBoxArea(box);
      if (bArea <= 0) continue;
      counts.checkedBoxes++;

      const inside = [];
      for (const d of dets) {
        const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
        if (cx < box.x || cx > box.x + box.w || cy < box.y || cy > box.y + box.h) continue;
        const inter = qBoxInter(box, d);
        if (inter / Math.max(1, Math.min(bArea, qBoxArea(d))) < 0.5) continue;
        inside.push(d);
      }
      inside.sort((a, b) => qBoxArea(b) - qBoxArea(a));

      const kept = [];
      for (const d of inside) {
        if (kept.some((k) => qBoxIou(k, d) > 0.55)) continue;
        kept.push(d);
      }

      const strongAll = kept.filter((d) => qBoxArea(d) >= Math.max(120, bArea * 0.12));
      // 其他标注框已经覆盖的检测（同一个人已有独立框）不再作为拆分目标，避免制造重复框
      const others = boxes.filter((_, i) => i !== idx);
      const coveredByOther = (d) => {
        const dArea = qBoxArea(d);
        return others.some((o) => {
          const inter = qBoxInter(o, d);
          if (!inter) return false;
          const minA = Math.max(1, Math.min(qBoxArea(o), dArea));
          if (inter / minA >= 0.55) return true;
          const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
          return cx >= d.x && cx <= d.x + d.w && cy >= d.y && cy <= d.y + d.h && inter / minA >= 0.4;
        });
      };
      const strong = strongAll.filter((d) => !coveredByOther(d));
      if (strong.length >= 2) {
        const parts = strong.slice(0, 6).map((d) => ({
          detId: d.id,
          x: Math.round(d.x), y: Math.round(d.y),
          w: Math.round(d.w), h: Math.round(d.h)
        }));
        suggestions.push({
          type: 'split', frame, boxIndex: idx,
          box: { id: Number(box.id), x: box.x, y: box.y, w: box.w, h: box.h },
          parts
        });
        counts.split++;
        continue;
      }

      // 多人但都已有独立框：不做任何拆分 / 收紧建议
      if (strongAll.length >= 2 && !strong.length) continue;

      if (kept.length) {
        const best = strong.length === 1 ? strong[0] : kept[0];
        const dArea = qBoxArea(best);
        const cover = dArea / bArea;
        const iou = qBoxIou(box, best);
        if (cover < 0.58 || cover > 1.25 || iou < 0.5) {
          suggestions.push({
            type: 'tighten', frame, boxIndex: idx,
            box: { id: Number(box.id), x: box.x, y: box.y, w: box.w, h: box.h },
            to: { x: Math.round(best.x), y: Math.round(best.y), w: Math.round(best.w), h: Math.round(best.h) },
            cover: Math.round(cover * 100) / 100,
            detId: best.id
          });
          counts.tighten++;
        }
      } else {
        suggestions.push({
          type: 'empty', frame, boxIndex: idx,
          box: { id: Number(box.id), x: box.x, y: box.y, w: box.w, h: box.h }
        });
        counts.empty++;
      }
    }
  }

  suggestions.sort((a, b) => a.frame - b.frame || a.boxIndex - b.boxIndex);
  return { suggestions, counts };
}

function finishQualityJob(job, msg) {
  if (job.status !== 'running') return;
  if (job.timer) { clearTimeout(job.timer); job.timer = null; }
  try {
    const outPath = msg.outPath || job.outPath;
    if (!outPath || !fs.existsSync(outPath)) throw new Error('未生成结果文件');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const projPath = path.join(PROJECTS_DIR, job.projectId + '.json');
    let proj = { annotations: {} };
    if (fs.existsSync(projPath)) {
      try { proj = JSON.parse(fs.readFileSync(projPath, 'utf8')) || proj; } catch (_) {}
    }
    const built = buildQualitySuggestions(proj.annotations || {}, data.frames || [], job.startFrame, job.count);
    job.suggestions = built.suggestions;
    job.summary = built.counts;
    job.status = 'done';
    job.progress = job.total;
    job.message = 'AI 深度质检完成';
  } catch (e) {
    job.status = 'error';
    job.error = '深度质检结果处理失败：' + e.message;
    job.message = job.error;
  }
}

// 启动 AI 深度质检（复用 SAM3 图像检测 worker，只做检测不写标注）
app.post('/api/quality/scan', (req, res) => {
  try {
    const body = req.body || {};
    const projectId = String(body.projectId || '');
    if (!/^[\w.-]+$/.test(projectId)) return res.status(400).json({ error: 'projectId 无效' });
    if (autoJobRunning()) return res.status(409).json({ error: 'AI 自动打标正在运行，请完成后再做深度质检' });
    if (qualityJobRunning()) return res.status(409).json({ error: '已有深度质检任务在运行，请等待完成' });
    if (Array.from(jobs.values()).some((j) => j.status === 'running')) {
      return res.status(409).json({ error: '智能跟踪正在运行，请完成后再做深度质检' });
    }

    const cap = autoCapability();
    if (!cap.available || !fs.existsSync(AUTO_IMAGE_WORKER)) {
      return res.status(503).json({ error: 'AI 深度质检不可用：' + (cap.reason || '缺少图像检测 worker') });
    }

    const framesDir = path.join(FRAMES_DIR, projectId);
    const metaPath = path.join(framesDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return res.status(400).json({ error: '该项目尚未分帧，请先分帧' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const totalFrames = Number(meta.count) || 0;
    if (totalFrames < 1) return res.status(400).json({ error: '该项目没有可用帧' });

    const projPath = path.join(PROJECTS_DIR, projectId + '.json');
    if (!fs.existsSync(projPath)) return res.status(400).json({ error: '该项目还没有标注，无法质检' });

    const startFrame = Math.max(1, Math.min(totalFrames, Math.round(Number(body.startFrame) || 1)));
    const maxCount = totalFrames - startFrame + 1;
    const count = Math.max(1, Math.min(maxCount, Math.round(Number(body.count) || maxCount)));
    // 只扫描有标注的帧：深度质检只检查已有框，跳过空帧可以避免长视频扫全帧导致超时
    let frameList = null;
    if (Array.isArray(body.frames) && body.frames.length) {
      const set = new Set();
      for (const v of body.frames) {
        const n = Math.round(Number(v));
        if (Number.isFinite(n) && n >= 1 && n <= totalFrames) set.add(n);
      }
      if (set.size) frameList = Array.from(set).sort((a, b) => a - b);
    }
    const scanStart = frameList ? frameList[0] : startFrame;
    const scanCount = frameList ? frameList[frameList.length - 1] - scanStart + 1 : count;
    const prompt = String(body.prompt || 'person').trim().slice(0, 60) || 'person';
    const minScore = clampNum(body.minScore, 0.05, 0.95, 0.35);
    const minAreaPct = clampNum(body.minArea, 0.001, 10, 0.03);
    const minArea = minAreaPct / 100;

    for (const key of Array.from(workers.keys())) stopWorker(key);

    pruneQualityJobs();
    const jobId = 'quality-' + genId();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const outPath = path.join(TMP_DIR, jobId + '.json');
    const reqId = ++reqSeq;

    const job = {
      jobId, status: 'running', progress: 0, total: frameList ? frameList.length : count,
      message: frameList
        ? `正在启动 SAM 3 深度质检（仅扫描 ${frameList.length} 个有标注的帧，首次加载模型约 10 秒）…`
        : '正在启动 SAM 3 深度质检（首次加载模型约 10 秒）…',
      suggestions: null, summary: null, error: null,
      projectId, startFrame: scanStart, count: scanCount, frames: frameList,
      prompt, createdAt: Date.now(),
      proc: null, outPath, stderr: ''
    };
    qualityJobs.set(jobId, job);
    currentQualityJobId = jobId;

    const proc = spawn(PYTHON, ['-u', AUTO_IMAGE_WORKER], {
      cwd: ROOT,
      env: samChildEnv(),
      windowsHide: true
    });
    job.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    let sentRequest = false;
    const sendRequest = () => {
      if (sentRequest) return;
      sentRequest = true;
      try {
        proc.stdin.write(JSON.stringify({
          type: 'auto', reqId,
          framesDir, startFrame: scanStart, count: frameList ? frameList.length : scanCount,
          frames: frameList || undefined, totalFrames,
          prompt, stride: 1, minScore, minArea, maxObjects: 300,
          crop: null, outPath
        }) + '\n');
      } catch (e) {
        failQualityJob(job, '无法向 worker 发送任务：' + e.message);
      }
    };

    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (job.status !== 'running') return;
      touchQualityJob(job);
      if (msg.type === 'ready') sendRequest();
      else if (msg.type === 'status') job.message = msg.message || job.message;
      else if (msg.type === 'progress') {
        job.progress = Number(msg.done) || job.progress;
        if (msg.total) job.total = Number(msg.total) || job.total;
      } else if (msg.type === 'result') finishQualityJob(job, msg);
      else if (msg.type === 'error') failQualityJob(job, msg.message || 'AI 深度质检失败');
    });

    proc.stderr.on('data', (buf) => {
      job.stderr = (job.stderr + buf.toString()).slice(-6000);
    });
    proc.on('error', (err) => failQualityJob(job, '无法启动 Python（' + PYTHON + '）：' + err.message));
    proc.on('close', (code) => {
      try { rl.close(); } catch (_) {}
      if (job.status === 'running') {
        const tail = job.stderr ? '：' + job.stderr.slice(-400).replace(/\s+/g, ' ') : '';
        failQualityJob(job, '深度质检进程已退出（code=' + code + '）' + tail);
      }
      job.proc = null;
    });

    touchQualityJob(job);

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quality/:jobId', (req, res) => {
  const job = qualityJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(publicQualityJob(job));
});

app.post('/api/quality/:jobId/cancel', (req, res) => {
  const job = qualityJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.message = '已取消';
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    try { if (job.proc) job.proc.kill(); } catch (_) {}
  }
  res.json({ ok: true, status: job.status });
});

app.listen(PORT, () => {
  console.log('视频打框标注工具已启动：http://127.0.0.1:' + PORT);
  console.log('按 Ctrl+C 可停止服务。');
  if (process.env.AUTO_OPEN === '1') {
    const url = 'http://127.0.0.1:' + PORT;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});

function killAllWorkers() {
  for (const key of Array.from(workers.keys())) stopWorker(key);
  for (const job of autoJobs.values()) {
    if (job.status === 'running') {
      try { if (job.proc) job.proc.kill(); } catch (_) {}
      job.status = 'cancelled';
    }
  }
}

process.on('exit', killAllWorkers);
process.on('SIGINT', () => { killAllWorkers(); process.exit(0); });
