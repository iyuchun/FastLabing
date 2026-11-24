'use strict';
// 导入别人导出的数据集 ZIP（COCO 格式），还原成可继续审查 / 修改的标注项目。
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');

const { TMP_DIR, FRAMES_DIR, PROJECTS_DIR } = require('./storage');
const { ffmpegPath, getJpegSize, runFfmpeg } = require('./extract');

const DEFAULT_ZIP_PASSWORD = 'Praaloox@0#';

function genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode || 400;
  return err;
}

function run7za(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(path7za, args, { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', (err) => reject(fail('无法启动 7za：' + err.message, 500)));
    proc.on('close', (code) => resolve({ code, out }));
  });
}

async function extractZip(zipPath, outDir, password) {
  fs.mkdirSync(outDir, { recursive: true });
  const pwd = String(password == null ? '' : password).trim() || DEFAULT_ZIP_PASSWORD;
  const args = ['x', '-tzip', '-y', '-bb0', '-p' + pwd, '-o' + outDir, zipPath];
  const { code, out } = await run7za(args);
  if (code === 0) return;

  if (/wrong password|data error|can not open encrypted|密码/i.test(out)) {
    throw fail('解压失败：密码错误（默认密码 Praaloox@0#）');
  }
  if (/can not open the file as archive|cannot open the file/i.test(out)) {
    throw fail('解压失败：不是有效的 ZIP 压缩包');
  }
  throw fail('解压失败：' + out.trim().split(/\r?\n/).slice(-3).join(' '));
}

function walkFiles(dir, visitor, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of entries) {
    if (ent.name === '__MACOSX') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, visitor, depth + 1);
    else if (ent.isFile()) visitor(p);
  }
}

// 在解压目录里找 COCO 标注 JSON：优先 instances_default.json
function findCocoJson(root) {
  const found = [];
  walkFiles(root, (file) => {
    if (!/\.json$/i.test(file)) return;
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return; }
    if (stat.size > 300 * 1024 * 1024) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return; }
    if (!data || !Array.isArray(data.images) || !Array.isArray(data.annotations)) return;
    let score = 0;
    if (/instances_default\.json$/i.test(file)) score += 10;
    if (Array.isArray(data.categories) && data.categories.length) score += 3;
    if (/[\\/]annotations[\\/]/i.test(file)) score += 2;
    found.push({ file, data, score });
  });
  found.sort((a, b) => b.score - a.score);
  return found[0] || null;
}

function toPosix(s) {
  return String(s || '').replace(/\\/g, '/');
}

function naturalCompare(a, b) {
  return toPosix(a).localeCompare(toPosix(b), undefined, { numeric: true, sensitivity: 'base' });
}

function safeInside(root, p) {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x === r || x.startsWith(r + path.sep);
}

function buildImageIndex(root) {
  const byBase = new Map();
  walkFiles(root, (file) => {
    if (!/\.(jpe?g|png)$/i.test(file)) return;
    const base = path.basename(file).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, file);
  });
  return byBase;
}

function resolveImageFile(root, annDir, name, imageIndex) {
  const rel = toPosix(name).replace(/^\/+/, '');
  if (!rel) return null;
  const bases = [root, annDir, path.dirname(annDir)];
  for (const base of bases) {
    const p = path.resolve(base, rel);
    if (safeInside(root, p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  // COCO 的 file_name 常不带 ZIP 里的顶层目录，按文件名兜底查找
  return imageIndex.get(path.basename(rel).toLowerCase()) || null;
}

function parseBoxCount(root) {
  let fps = null;
  let sourceName = '';
  walkFiles(root, (file) => {
    if (path.basename(file).toLowerCase() !== 'box_count.txt') return;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    const fpsMatch = text.match(/目标\s*FPS\s*[:：]\s*([\d.]+)/i);
    if (fpsMatch) fps = Number(fpsMatch[1]) || null;
    const nameMatch = text.match(/视频项目\s*[:：]\s*(.+)/);
    if (nameMatch) sourceName = nameMatch[1].trim();
  });
  return { fps, sourceName };
}

function cleanDatasetName(name) {
  let s = String(name || '');
  s = s.replace(/\.zip$/i, '').replace(/^数据集[_\-\s]*/i, '').replace(/_\d{10,}$/, '');
  return s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60);
}

async function makeThumbs(framesDir, ext, count) {
  if (!ffmpegPath || !count) return [];
  const pattern = path.join(framesDir, 'frame_%06d' + ext);
  try {
    await runFfmpeg([
      '-y', '-i', pattern,
      '-vf', 'scale=160:-2',
      '-q:v', '5',
      '-frames:v', String(count),
      path.join(framesDir, 'thumb_%06d.jpg')
    ]);
  } catch (_) {
    return [];
  }
  const thumbs = fs.readdirSync(framesDir)
    .filter((f) => /^thumb_\d+\.jpg$/.test(f))
    .sort();
  return thumbs.length === count ? thumbs : [];
}

/**
 * 把加密数据集 ZIP 导入为项目。
 * 返回 { projectId, name, frames, boxes, width, height, fps, categoryName, skippedImages }
 */
async function importDatasetZip(zipPath, options) {
  const opts = options || {};
  if (!zipPath || !fs.existsSync(zipPath)) throw fail('未收到数据集压缩包');

  const workDir = path.join(TMP_DIR, 'import-' + genId());
  fs.mkdirSync(workDir, { recursive: true });

  try {
    await extractZip(zipPath, workDir, opts.password);
    const coco = findCocoJson(workDir);
    if (!coco) {
      throw fail('不是本工具支持的数据集：压缩包里没找到 COCO 标注文件（instances_default.json）');
    }

    const annDir = path.dirname(coco.file);
    const imageIndex = buildImageIndex(workDir);
    const { fps: boxFps, sourceName } = parseBoxCount(workDir);

    const images = coco.data.images
      .filter((im) => im && (im.file_name || im.fileName))
      .sort((a, b) => naturalCompare(a.file_name || a.fileName, b.file_name || b.fileName));

    const annByImage = new Map();
    for (const a of coco.data.annotations) {
      if (!a) continue;
      const key = String(a.image_id);
      if (!annByImage.has(key)) annByImage.set(key, []);
      annByImage.get(key).push(a);
    }

    // 先确认每个 COCO image 对应的图片文件
    const resolved = [];
    for (const im of images) {
      const src = resolveImageFile(workDir, annDir, im.file_name || im.fileName, imageIndex);
      if (!src) continue;
      resolved.push({ image: im, src });
    }
    if (!resolved.length) throw fail('数据集里没有可用的帧图片（images 与图片文件不匹配）');

    const extSet = new Set(resolved.map((r) => {
      const e = path.extname(r.src).toLowerCase();
      return e === '.jpeg' ? '.jpg' : e;
    }));
    if (extSet.size > 1) throw fail('暂不支持混合图片格式（' + Array.from(extSet).join(' / ') + '）的数据集');
    const ext = Array.from(extSet)[0] || '.jpg';

    const projectId = genId();
    const framesDir = path.join(FRAMES_DIR, projectId);
    fs.mkdirSync(framesDir, { recursive: true });

    let width = 0;
    let height = 0;
    const files = [];
    const annotations = {};
    let boxTotal = 0;
    let fallbackId = 0;

    for (let i = 0; i < resolved.length; i++) {
      const frameNo = i + 1;
      const { image, src } = resolved[i];
      const fileName = 'frame_' + String(frameNo).padStart(6, '0') + ext;
      fs.copyFileSync(src, path.join(framesDir, fileName));
      files.push(fileName);

      if (!width || !height) {
        const w = Number(image.width) || 0;
        const h = Number(image.height) || 0;
        if (w > 0 && h > 0) { width = w; height = h; }
        else if (ext === '.jpg') {
          try { const size = getJpegSize(fs.readFileSync(src)); width = size.width; height = size.height; } catch (_) {}
        }
      }

      const srcAnns = annByImage.get(String(image.id)) || [];
      const boxes = [];
      for (const a of srcAnns) {
        let x, y, w, h;
        if (Array.isArray(a.bbox) && a.bbox.length >= 4) {
          [x, y, w, h] = a.bbox.map(Number);
        } else {
          x = Number(a.x); y = Number(a.y); w = Number(a.w); h = Number(a.h);
        }
        if (![x, y, w, h].every(Number.isFinite)) continue;
        x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
        if (w <= 1 || h <= 1) continue;
        if (width > 0) { x = Math.max(0, Math.min(x, width - 2)); w = Math.min(w, width - x); }
        if (height > 0) { y = Math.max(0, Math.min(y, height - 2)); h = Math.min(h, height - y); }
        if (w < 2 || h < 2) continue;

        let id = Number(a.track_id ?? a.trackId ?? a.instance_id ?? a.instanceId);
        if (!(id >= 1)) id = Number(a.id);
        if (!(id >= 1)) id = ++fallbackId;
        id = Math.max(1, Math.round(id));
        boxes.push({ id, x, y, w, h });
      }
      if (boxes.length) {
        annotations[String(frameNo)] = boxes;
        boxTotal += boxes.length;
      }
    }

    if (!width || !height) {
      try {
        const size = getJpegSize(fs.readFileSync(path.join(framesDir, files[0])));
        width = size.width; height = size.height;
      } catch (_) {}
    }

    const thumbs = await makeThumbs(framesDir, ext, files.length);
    const catName = (Array.isArray(coco.data.categories) && coco.data.categories[0] && String(coco.data.categories[0].name || '').trim()) || 'object';
    const fps = Number(boxFps) > 0 ? Number(boxFps) : 10;

    const meta = {
      projectId,
      fps,
      count: files.length,
      width,
      height,
      files,
      thumbs,
      imported: true,
      importedAt: Date.now()
    };
    fs.writeFileSync(path.join(framesDir, 'meta.json'), JSON.stringify(meta, null, 2));

    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROJECTS_DIR, projectId + '.json'), JSON.stringify({
      categoryName: catName,
      annotations,
      imported: true,
      importedAt: Date.now(),
      importedFrom: opts.originalName || path.basename(zipPath)
    }, null, 2));

    const name = String(opts.name || '').trim().slice(0, 60) ||
      cleanDatasetName(sourceName || opts.originalName || path.basename(zipPath));

    return {
      projectId,
      name,
      frames: files.length,
      boxes: boxTotal,
      width,
      height,
      fps,
      categoryName: catName,
      skippedImages: images.length - resolved.length,
      skippedAnnotations: coco.data.annotations.length - boxTotal
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { importDatasetZip, DEFAULT_ZIP_PASSWORD };
