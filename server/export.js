'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');

const { STORAGE, FRAMES_DIR, PROJECTS_DIR, EXPORT_DIR, ZIP_DIR } = require('./storage');

const ZIP_PASSWORD = 'Praaloox@0#';

function sanitizeName(s) {
  return String(s || 'video').replace(/[\\/:*?"<>|\s]+/g, '_');
}

function zipWith7za(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const args = ['a', '-tzip', `-p${ZIP_PASSWORD}`, '-mem=ZipCrypto', '-y', zipPath, '.'];
    const proc = spawn(path7za, args, { cwd: sourceDir });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', (err) => reject(new Error('无法启动 7za：' + err.message)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error('7za 加密打包失败：' + out.slice(-500)));
    });
  });
}

/**
 * 导出 COCO 数据集 + box_count.txt + 帧图片，并打包为 ZipCrypto 加密 zip。
 * 返回 { downloadUrl, filename, totalBoxes, categoryName }
 */
async function exportDataset(projectId, categoryName) {
  const framesDir = path.join(FRAMES_DIR, projectId);
  const metaPath = path.join(framesDir, 'meta.json');
  if (!fs.existsSync(metaPath)) throw new Error('未找到分帧结果，请先分帧');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  const projPath = path.join(PROJECTS_DIR, projectId + '.json');
  const proj = fs.existsSync(projPath) ? JSON.parse(fs.readFileSync(projPath, 'utf8')) : {};
  const annotations = proj.annotations || {};
  const catName = (categoryName && String(categoryName).trim()) || proj.categoryName || 'object';

  const exportRoot = path.join(EXPORT_DIR, projectId);
  fs.rmSync(exportRoot, { recursive: true, force: true });
  const annDir = path.join(exportRoot, 'annotations');
  const imgDir = path.join(exportRoot, 'images');
  fs.mkdirSync(annDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });

  // 复制帧图
  for (const f of meta.files) {
    const src = path.join(framesDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(imgDir, f));
  }

  // 构建 COCO
  const coco = {
    info: {
      description: '视频打框标注工具导出',
      version: '1.0',
      date_created: new Date().toISOString()
    },
    licenses: [],
    images: [],
    annotations: [],
    categories: [{ id: 1, name: catName, supercategory: '' }]
  };

  let annId = 1;
  let total = 0;
  const perFrame = [];
  meta.files.forEach((f, idx) => {
    const imageId = idx + 1;
    coco.images.push({ id: imageId, file_name: f, width: meta.width, height: meta.height });
    const boxes = annotations[String(imageId)] || annotations[String(idx + 1)] || [];
    perFrame.push(boxes.length);
    total += boxes.length;
    for (const b of boxes) {
      const x = Number(b.x) || 0, y = Number(b.y) || 0, w = Number(b.w) || 0, h = Number(b.h) || 0;
      coco.annotations.push({
        id: annId++,
        image_id: imageId,
        category_id: 1,
        bbox: [x, y, w, h],
        area: Math.round(w * h),
        iscrowd: 0,
        track_id: Number(b.id) || 0
      });
    }
  });
  fs.writeFileSync(path.join(annDir, 'instances_default.json'), JSON.stringify(coco, null, 2));

  // box_count.txt
  const lines = [
    `视频项目: ${projectId}`,
    `类别: ${catName}`,
    `目标FPS: ${meta.fps}`,
    `总帧数: ${meta.count}`,
    `标注框总数: ${total}`,
    '',
    '每帧框数:'
  ];
  meta.files.forEach((f, idx) => lines.push(`${f}: ${perFrame[idx]}`));
  fs.writeFileSync(path.join(exportRoot, 'box_count.txt'), lines.join('\r\n'), 'utf8');

  // 加密打包
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  const zipName = `数据集_${sanitizeName(projectId)}_${Date.now()}.zip`;
  const zipPath = path.join(ZIP_DIR, zipName);
  await zipWith7za(exportRoot, zipPath);

  return {
    downloadUrl: '/api/download/' + zipName,
    filename: zipName,
    totalBoxes: total,
    categoryName: catName
  };
}

module.exports = { exportDataset, ZIP_PASSWORD };
