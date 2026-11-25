# FastLabing 视频标注台

浏览器里的视频目标框标注工具：上传视频 → 抽帧 → 画框 → SAM 2.1 / SAM 3 跨帧跟踪 → 批量管理 → 导出 COCO 数据集（可加密打包）。

## 功能

- 上传 MP4 等视频，按指定 FPS 抽帧（默认 10 fps）
- 画框、移动、缩放、改 ID、删除，支持 Ctrl+Z 撤销
- 新增框自动取「当前最大 ID + 1」；「沿用上一帧」继承上一帧最后一个框的 ID
- SAM 3 / SAM 2.1 双模型跟踪，模型可随时切换
- 跟踪默认跳过已有同 ID 的帧，只补空缺；行尾勾选「覆盖」可强制重跟并替换旧框
- 任务中断自动跳到最后一个完成帧，不会把半成品写进标注
- 按 ID 全局显隐、当前帧多选、批量删除/跟踪、批量改 ID（全部帧/当前帧/帧范围）
- 实时 GPU 监控、缩略图条、项目增删改查、项目目录一键打开
- 导出 COCO 格式并生成加密 ZIP

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 x64 |
| 显卡 | NVIDIA，建议 8GB 显存以上（SAM 2.1 约 1GB，SAM 3 建议 12GB 以上更流畅） |
| Node.js | 18 或更高 |
| Python | 3.12 |
| 磁盘 | 预留约 12GB（依赖 + 3.4GB 模型权重 + 数据） |

## 快速开始

1. 双击 **`一键安装依赖.bat`**
   - 自动执行 `npm install`
   - 创建 `.venv`，安装 PyTorch 2.10.0 + CUDA 12.8 与全部 Python 依赖
   - 校验 SAM 2.1 / SAM 3 权重
2. 双击 **`一键启动.bat`**
   - 默认地址：<http://127.0.0.1:3000>（3000 被占用时自动顺延到下一个空闲端口）
   - 浏览器会自动打开；关闭窗口或 Ctrl+C 停止服务
3. 双击 **`一键删除.bat`**
   - 停止服务并删除 `.venv`、`node_modules`、缓存
   - 可选删除模型权重、项目数据（会有明确确认）

> 安装脚本只是把依赖装到本目录的 `.venv` 和 `node_modules`，不会修改系统环境。

## 数据与代码分离

所有项目数据默认放在程序**同级**目录：

```
F:\Fastlabing\          程序与依赖
F:\Fastlabing-data\     视频、帧图、标注、导出（运行时自动创建）
```

分发包里不包含 `Fastlabing-data`，把 `FastLabing` 文件夹压缩给别人即可。数据目录可用环境变量 `FASTLABING_STORAGE` 改到其他位置。

标注文件位置：`<数据目录>\projects\<项目ID>.json`
帧图片位置：`<数据目录>\frames\<项目ID>\`
导出文件：`<数据目录>\exports\` 与 `<数据目录>\zip\`

## 模型权重

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| SAM 2.1 tiny | `models\sam2.1_hiera_tiny.pt` | 约 150MB，速度约 0.2 秒/帧，显存约 1GB |
| SAM 3 | `models\sam3.pt` | 约 3.3GB，精度更高，显存占用更大 |

- 安装脚本会在缺失 SAM 2.1 权重时自动下载。
- SAM 3 权重受官方许可限制，需从 <https://huggingface.co/facebook/sam3> 获取后放入 `models\`。没有 SAM 3 权重时仍可正常使用 SAM 2.1。
- 8GB 显存建议优先使用 SAM 2.1；SAM 3 可选「快速 / 极速」精度档位（隔帧跟踪 + 线性插值）。

## 使用流程

1. 点击「导入视频」，选择文件并设置目标 FPS，点击「分帧」
2. 在画布上拖拽画框；右侧「当前帧标注框」可改 ID、删除、显隐、勾选
3. 设置「跟踪帧数」，选择 SAM 3 或 SAM 2.1，点击「用选中框跟踪」
4. 需要覆盖后续已有框时，勾选该行行尾的「覆盖」
5. 完成后导出 COCO，必要时生成加密 ZIP

## 目录结构

```
FastLabing/
├─ 一键安装依赖.bat / 一键启动.bat / 一键删除.bat
├─ scripts/                 安装、启动、删除脚本
├─ server/                  Express 服务、抽帧、导出、SAM worker
├─ public/                  前端页面与静态资源
├─ bin/ffmpeg.exe           内置抽帧工具
├─ models/                  SAM 2.1 / SAM 3 权重
├─ python/requirements.txt  Python 依赖清单
└─ third_party/sam3/        SAM 3 源码（含 tokenizer 资源）
```

## 常见问题

**提示未找到 Node.js / Python 3.12**
按提示安装后重新运行「一键安装依赖.bat」。安装 Python 时请勾选 “Add python.exe to PATH”。

**安装 PyTorch 很慢或失败**
需要访问 `download.pytorch.org`。可配置代理后重试。如果本机已经有装好依赖的 Python 环境（含 CUDA 版 torch、sam2），可在程序目录新建 `python-path.txt`，写入该环境的 `python.exe` 完整路径，安装和启动会直接复用它，不再创建 `.venv`。这个文件只适合本机使用，分发前请删除。

**端口 3000 被占用**
启动脚本会自动尝试 3001、3002……；也可以手动设置环境变量 `PORT=3100` 后启动。

**SAM 3 很慢 / 显存不足**
改用 SAM 2.1，或在 SAM 3 下选择「快速 / 极速」。8GB 显卡长时间跟踪建议使用 SAM 2.1。

**删除后想彻底重装**
运行「一键删除.bat」并选择删除模型；再运行「一键安装依赖.bat」。

## 环境变量（进阶）

| 变量 | 作用 |
| --- | --- |
| `FASTLABING_STORAGE` | 数据目录，默认 `..\Fastlabing-data` |
| `PORT` | 服务端口，默认 3000 |
| `PYTHON` | 指定 Python 解释器（默认 `.venv\Scripts\python.exe`） |
| `SAM3_REPO` / `SAM3_CKPT` | SAM 3 源码与权重路径 |
| `SAM2_CKPT` | SAM 2.1 权重路径 |
| `AUTO_OPEN` | 设为 1 时启动后自动打开浏览器 |

## 第三方组件

- [SAM 3](https://github.com/facebookresearch/sam3)（Meta，权重与代码遵循其官方许可）
- [SAM 2](https://github.com/facebookresearch/sam2)（Meta，Apache 2.0）
- [FFmpeg](https://ffmpeg.org/)（LGPL/GPL，随包提供二进制）
- [7-Zip](https://www.7-zip.org/)（通过 `7zip-bin` 调用，用于加密 ZIP）
