'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { ROOT, FRAMES_DIR } = require('./storage');

// 优先使用项目内置 ffmpeg（bin/ffmpeg.exe），安装时无需联网从 GitHub 下载
const BUNDLED_FFMPEG = path.join(ROOT, 'bin', 'ffmpeg.exe');
let ffmpegPath;
if (fs.existsSync(BUNDLED_FFMPEG)) {
  ffmpegPath = BUNDLED_FFMPEG;
} else {
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (_) {
    ffmpegPath = null;
  }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('未找到 ffmpeg 可执行文件（bin/ffmpeg.exe）。请重新运行「一键安装依赖.bat」。');
  }
}

/**
 * 解析 JPEG 尺寸（读 SOF 标记），返回 { width, height }
 */
function getJpegSize(buf) {
  if (!buf || buf[0] !== 0xFF || buf[1] !== 0xD8) {
    throw new Error('不是有效的 JPEG 文件');
  }
  const SOF = [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF];
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (SOF.includes(marker)) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    // 无长度标记：SOI(0xD8)、EOI(0xD9)、RSTn(0xD0-0xD7)
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  throw new Error('无法解析 JPEG 尺寸');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error('无法启动 ffmpeg：' + err.message)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg 执行失败：' + stderr.slice(-500)));
      resolve();
    });
  });
}

function clearDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  }
}

/**
 * 按目标 FPS 抽取视频帧，输出到 storage/frames/<projectId>/
 * 同时生成缩略图用于前端导航条。
 * 返回 { projectId, fps, count, width, height, files, thumbs }
 */
async function extractFrames(videoPath, projectId, fps) {
  const framesDir = path.join(FRAMES_DIR, projectId);
  clearDir(framesDir);

  const framePattern = path.join(framesDir, 'frame_%06d.jpg');
  const thumbPattern = path.join(framesDir, 'thumb_%06d.jpg');

  // 1) 全分辨率帧
  await runFfmpeg([
    '-y', '-i', videoPath,
    '-vf', `fps=${fps}`,
    '-q:v', '2',
    '-start_number', '1',
    framePattern
  ]);

  // 2) 缩略图（宽 160，高度保持偶数，用于导航条）
  try {
    await runFfmpeg([
      '-y', '-i', videoPath,
      '-vf', `fps=${fps},scale=160:-2`,
      '-q:v', '5',
      '-start_number', '1',
      thumbPattern
    ]);
  } catch (_) {
    // 缩略图失败不影响主流程
  }

  const files = fs.readdirSync(framesDir)
    .filter((f) => /^frame_\d+\.jpg$/.test(f))
    .sort();
  const thumbs = fs.readdirSync(framesDir)
    .filter((f) => /^thumb_\d+\.jpg$/.test(f))
    .sort();

  if (files.length === 0) {
    throw new Error('分帧后没有生成任何图片（请确认上传的是有效的 mp4 视频）');
  }

  let width = 0, height = 0;
  try {
    const first = fs.readFileSync(path.join(framesDir, files[0]));
    const s = getJpegSize(first);
    width = s.width; height = s.height;
  } catch (_) {}

  const meta = {
    projectId,
    fps,
    count: files.length,
    width,
    height,
    files,
    thumbs: thumbs.length === files.length ? thumbs : []
  };
  fs.writeFileSync(path.join(framesDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

module.exports = { extractFrames, FRAMES_DIR };
