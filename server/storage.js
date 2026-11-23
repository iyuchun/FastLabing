'use strict';
// 运行数据统一放在程序目录之外，避免把视频、帧图、标注混进代码包。
// 可用环境变量 FASTLABING_STORAGE 覆盖（一键启动脚本会设置）。
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORAGE = process.env.FASTLABING_STORAGE || path.join(ROOT, '..', 'Fastlabing-data');

module.exports = {
  ROOT,
  STORAGE,
  FRAMES_DIR: path.join(STORAGE, 'frames'),
  PROJECTS_DIR: path.join(STORAGE, 'projects'),
  UPLOAD_DIR: path.join(STORAGE, 'uploads'),
  EXPORT_DIR: path.join(STORAGE, 'exports'),
  ZIP_DIR: path.join(STORAGE, 'zip'),
  TMP_DIR: path.join(STORAGE, 'tmp')
};
