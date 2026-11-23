# -*- coding: utf-8 -*-
"""SAM3 全自动检测 + 跨帧跟踪工作进程（文本提示词，默认 "person"）。

协议：启动后立即输出 {"type":"ready"}，从 stdin 读一行 JSON 请求，处理完写出结果后退出
（一次进程一个任务，不做常驻）。

输入（每行一个 JSON）：
  {"type":"auto","reqId":1,"framesDir":"D:\\...\\storage\\frames\\<projectId>",
   "startFrame":1,"count":590,"totalFrames":590,"prompt":"person","stride":1,
   "minScore":0.5,"minArea":0.0005,"maxObjects":100,
   "outPath":"D:\\...\\storage\\tmp\\auto_<jobId>.json"}
  {"type":"ping"}

输出（stdout 只允许协议行，模型/第三方库日志全部走 stderr）：
  {"type":"ready"}
  {"type":"status","message":"正在加载 SAM3 模型（首次约 20-60 秒）…"}
  {"type":"progress","reqId":1,"done":120,"total":590,"found":13}
  {"type":"result","reqId":1,"outPath":"...","frameCount":590,"boxCount":8123,"objectCount":37}
  {"type":"error","reqId":1,"message":"..."}
  {"type":"pong"}

结果 JSON（outPath）：
  {"frames":[{"frame":1,"boxes":[{"id":3,"x":1100,"y":265,"w":59,"h":202,"score":0.93}]}],
   "meta":{"prompt":"person","startFrame":1,"count":590,"width":1920,"height":1080, ...}}

实现要点：
- 帧路径固定为 frame_%06d.jpg；startFrame/count 按 totalFrames 截断。
- SAM3 视频跟踪器开始会话时默认会把所有帧堆到 GPU（590 帧约 3.6GB），
  这里强制 offload_video_to_cpu=True，只在推理当前帧时搬到 GPU，长视频不爆显存。
- 模型输出坐标是归一化 xywh（相对原图），这里乘回原图宽高、取整并 clamp。
- 按 minScore 过滤（out_probs）、按 minArea（像素面积 / (W*H)）过滤、按 maxObjects 截断。
- 每一帧都写一条记录（没目标就是空 boxes），后端才能按覆盖策略清掉漏检。
- SAM3 的 obj id 从 0 开始，这里整体 +1 映射成 1..K 的稳定 id，避免和后端 id 0/1 冲突。
"""
import contextlib
import gc
import json
import os
import shutil
import sys
import tempfile
import time

# ---------- 基础环境（必须在 import torch 之前设置） ----------
try:  # 中文日志/路径：强制 UTF-8，避免 GBK 控制台崩
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    # 请求 JSON 里含中文路径（server.js 以 UTF-8 写入）；默认 stdin 会按 locale(GBK) 解码，
    # 这里强制 UTF-8，即使调用方没设 PYTHONIOENCODING 也不会乱码/报错。
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# OpenMP 运行库重复加载（常见 OMP: Error #15）的官方绕过开关
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# 长视频里每帧的 tensor 尺寸/生命周期差异很大，默认分配器会产生大量碎片
# （实测 reserved 比 allocated 高 2GB+，逼近 8G 卡上限）。expandable_segments
# 可显著降低碎片与 reserved 峰值，必须在首次 CUDA 初始化前设置。
if "PYTORCH_CUDA_ALLOC_CONF" not in os.environ and "PYTORCH_ALLOC_CONF" not in os.environ:
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

# ---------- 协议 stdout 保护 ----------
# 复制真实 stdout 仅用于协议输出，再把 fd 1 重定向到 stderr，
# 这样模型/第三方库的任何 print、tqdm 都不会污染 NDJSON 协议流。
_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(
    os.environ.get("SAM3_REPO") or os.path.join(_HERE, "..", "third_party", "sam3")
)
CKPT = os.path.abspath(
    os.environ.get("SAM3_CKPT") or os.path.join(_HERE, "..", "models", "sam3.pt")
)
# 时域消歧（hotstart + recondition）。1=开（官方默认，跨帧去重更好，但前 15 帧输出会被缓冲延迟）；
# 0=关（从第 1 帧起立即输出，短片段标注更完整）。
TD = os.environ.get("SAM3_TD", "1").strip().lower() not in ("0", "false", "off", "no")
# tracker 跨帧状态（maskmem 特征 + 低分 mask）只保留最近 N 帧，防止长视频 CPU 内存线性爆掉。
# 跟踪只用最近 num_maskmem=7 帧记忆 + 首帧条件帧（cond_frame_outputs 不裁），60 帧窗口远远够用。
TRIM_KEEP = int(os.environ.get("SAM3_TRIM_KEEP", "60") or 60)
# 送模型的帧最大宽度：SAM3 内部固定把帧缩放到 1008×1008（方形拉伸），
# 1920 宽先降到 960 再送，检测几何完全一致，但输出 mask 分辨率减半，
# 多人时的高分辨率 mask 后处理（O(N²)）成本降到约 1/4，显存也明显降低。
DOWNSCALE_W = int(os.environ.get("SAM3_DOWNSCALE_WIDTH", "960") or 0)

if REPO not in sys.path:
    sys.path.insert(0, REPO)

from PIL import Image  # noqa: E402

_predictor = None
_load_seconds = 0.0


def send(obj):
    _out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _out.flush()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class LazyFrames(list):
    """按需打开帧文件的只读序列（避免一次性把几百张 PIL 图读进内存）。

    继承 list 是因为 SAM3 内部用 isinstance(resource_path, list) 判断帧列表。
    SAM3 会遍历它两次（一次校验、一次真正的读入/缩放），这里用生成器按需打开。
    """

    def __init__(self, paths):
        super().__init__()
        self.paths = paths

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        with Image.open(self.paths[i]) as im:
            return im.convert("RGB")

    def __iter__(self):
        for p in self.paths:
            with Image.open(p) as im:
                yield im.convert("RGB")


def get_predictor():
    """加载 SAM3 视频预测器（首次约 10 秒，权重 3.45GB）。"""
    global _predictor, _load_seconds
    if _predictor is not None:
        return _predictor
    if not os.path.isfile(CKPT):
        raise RuntimeError("找不到 SAM3 权重：" + CKPT)
    send({"type": "status", "message": "正在加载 SAM3 模型（首次约 20-60 秒）…"})
    t0 = time.time()
    from sam3.model_builder import build_sam3_video_predictor

    with contextlib.redirect_stdout(sys.stderr):
        _predictor = build_sam3_video_predictor(
            CKPT, apply_temporal_disambiguation=TD
        )
    _load_seconds = time.time() - t0

    # 关键：视频帧默认 offload_video_to_cpu=False（整段视频堆进显存，长片必 OOM）。
    # start_session() 没有暴露这个参数，这里包装一下模型的 init_state 强制走 CPU。
    # 同时强制 async_loading_frames=True：配合「传目录」的会话方式，SAM3 用
    # AsyncImageFrameLoader 按需从磁盘读帧（帧常驻 CPU），GPU 只保留当前帧；
    # 否则 _construct_initial_input_batch() 里的 copy_data_to_device 会把整段视频
    # （590 帧 × 3×1008×1008 fp16 ≈ 3.6GB）一次搬上 GPU，8G 卡会被塞满并掉速 10 倍。
    _orig_init_state = _predictor.model.init_state

    def _init_state_offload(*args, **kwargs):
        kwargs["offload_video_to_cpu"] = True
        kwargs["async_loading_frames"] = True
        return _orig_init_state(*args, **kwargs)

    _predictor.model.init_state = _init_state_offload
    # start_session 会把 self.async_loading_frames 传给 init_state，这里也置 True。
    _predictor.async_loading_frames = True

    # 长视频省显存：SAM3 会把每一帧的全分辨率 mask 缓存进
    # inference_state["cached_frame_outputs"]（每人 1920×1080 bool ≈ 2MB/帧），
    # 590 帧线性累积可达数 GB，8G 卡会在中途 OOM。
    # 全自动打标只做「文本提示 + 一次 forward 传播」，不会走交互式 refine/fetch 分支，
    # 这份缓存没有任何消费者，直接停用。
    def _noop_cache_frame_outputs(*args, **kwargs):
        return None

    _predictor.model._cache_frame_outputs = _noop_cache_frame_outputs
    log("[auto_worker] 已停用 cached_frame_outputs（长视频显存优化）")

    # 关键3：SAM3 tracker 会把每一帧的 maskmem 特征 + 低分辨率 mask 存进
    # inference_state["output_dict"]（每目标每帧约 1MB），tracker.init_state 的
    # offload_state_to_cpu 默认 False → 这份跨帧状态全在 GPU 上线性累积，
    # 590 帧多人会涨到数 GB 并 OOM。官方注释：打开它省显存，只略降跟踪 fps
    # （读取时源码会 .cuda() 搬回）。这里强制打开。
    _orig_tracker_init_state = _predictor.model.tracker.init_state

    def _tracker_init_state_offload(*args, **kwargs):
        kwargs["offload_state_to_cpu"] = True
        return _orig_tracker_init_state(*args, **kwargs)

    _predictor.model.tracker.init_state = _tracker_init_state_offload
    log("[auto_worker] 已启用 tracker offload_state_to_cpu（长视频显存优化）")
    send({"type": "status", "message": "SAM3 模型加载完成（%.1fs）" % _load_seconds})
    log(
        "[auto_worker] model loaded in %.1fs (temporal_disambiguation=%s)" %
        (_load_seconds, TD)
    )
    return _predictor


def _read_dims(path):
    with Image.open(path) as im:
        return im.size  # (w, h)


def _prepare_frame_dir(paths, req_id):
    """把本次要处理的帧硬链接（或按需降采样复制）到临时目录，文件名 000001.jpg 递增。

    为什么要多这一步：SAM3 的 AsyncImageFrameLoader 只有在 resource_path 是
    「目录字符串」时才会启用（帧常驻 CPU、按需加载）；若直接传帧列表，
    init_state 内部 copy_data_to_device 会把整段视频张量一次搬上 GPU
    （590 帧约 3.6GB，8G 卡必塞满并掉速约 10 倍）。
    loader 按文件名里的整数排序，所以这里从 1 开始编号。
    若 DOWNSCALE_W > 0 且原始帧更宽，写入按比例缩小的副本（输出框仍按原始宽高换算）。
    """
    tmp_root = (
        os.environ.get("SAM3_TMP_DIR")
        or os.environ.get("SAM2_TMP_DIR")
        or tempfile.gettempdir()
    )
    tmp_root = os.path.abspath(tmp_root)
    os.makedirs(tmp_root, exist_ok=True)
    tmp_dir = os.path.join(
        tmp_root, "sam3_auto_%d_%s" % (os.getpid(), req_id if req_id is not None else 0)
    )
    shutil.rmtree(tmp_dir, ignore_errors=True)  # 清理同名残留
    os.makedirs(tmp_dir, exist_ok=True)
    scale = None
    if DOWNSCALE_W > 0:
        w0, h0 = _read_dims(paths[0])
        if w0 > DOWNSCALE_W:
            scale = (DOWNSCALE_W, max(2, int(round(h0 * float(DOWNSCALE_W) / float(w0)))))
            log("[auto_worker] 帧降采样 %dx%d -> %dx%d（提速/省显存）"
                % (w0, h0, scale[0], scale[1]))
    for i, src in enumerate(paths):
        dst = os.path.join(tmp_dir, "%06d.jpg" % (i + 1))
        if scale is None:
            try:
                os.link(src, dst)  # 同盘硬链接，几乎零成本
                continue
            except OSError:
                shutil.copyfile(src, dst)
                continue
        with Image.open(src) as im:
            im = im.convert("RGB")
            if scale is not None:
                im = im.resize(scale, Image.LANCZOS)
            im.save(dst, quality=92)
    return tmp_dir


def trim_tracker_outputs(predictor, session_id, frame_index, keep=TRIM_KEEP):
    """裁掉 tracker 中「超过最近 keep 帧」的非条件帧输出缓存，给长视频 CPU 内存兜底。

    SAM3 tracker 默认把每一帧的 maskmem 特征 + 低分辨率 mask 永久存进
    inference_state（假设交互式短视频）。590 帧 × 多人时这份状态会涨到几十 GB。
    跟踪实际只用最近 num_maskmem(=7) 帧记忆 + 首帧条件帧，保留最近 keep 帧远够用。
    注意：只裁 non_cond_frame_outputs，cond_frame_outputs（首帧提示帧）永远保留。
    """
    try:
        sess = predictor._ALL_INFERENCE_STATES.get(session_id)
        if not sess:
            return
        state = sess.get("state") or {}
        cutoff = frame_index - keep
        if cutoff <= 0:
            return
        for st in state.get("tracker_inference_states", []) or []:
            dicts = []
            od = st.get("output_dict")
            if od:
                dicts.append(od)
            for per in (st.get("output_dict_per_obj") or {}).values():
                dicts.append(per)
            for d in dicts:
                nc = d.get("non_cond_frame_outputs")
                if not nc:
                    continue
                for f in [x for x in nc if x < cutoff]:
                    nc.pop(f, None)
    except Exception as e:  # 裁剪失败不影响主流程
        log("[auto_worker] trim 失败（忽略）: %r" % e)


def _parse_request(req):
    """校验/规整请求参数，返回处理参数 dict。"""
    frames_dir = req.get("framesDir")
    if not frames_dir or not isinstance(frames_dir, str):
        raise RuntimeError("缺少 framesDir")
    if not os.path.isdir(frames_dir):
        raise RuntimeError("帧目录不存在：" + frames_dir)

    total_frames = int(req.get("totalFrames") or 0)
    start = int(req.get("startFrame") or 1)
    if start < 1:
        start = 1
    if total_frames > 0:
        start = min(start, total_frames)
    count = int(req.get("count") or 0)
    if total_frames > 0:
        count = min(count, total_frames - start + 1)
    if count < 1:
        raise RuntimeError("count 无效（需要 >=1）")

    prompt = str(req.get("prompt") or "person").strip() or "person"
    min_score = clamp(float(req.get("minScore") if req.get("minScore") is not None else 0.5), 0.0, 1.0)
    min_area = max(0.0, float(req.get("minArea") if req.get("minArea") is not None else 0.0005))
    max_objects = int(clamp(int(req.get("maxObjects") or 100), 1, 2000))
    out_path = req.get("outPath")
    if not out_path or not isinstance(out_path, str):
        raise RuntimeError("缺少 outPath")
    stride = int(req.get("stride") or 1)
    if stride < 1:
        stride = 1

    paths = []
    for i in range(count):
        p = os.path.join(frames_dir, "frame_%06d.jpg" % (start + i))
        if not os.path.isfile(p):
            raise RuntimeError("缺少帧文件：" + os.path.basename(p))
        paths.append(p)

    width, height = _read_dims(paths[0])
    if width < 2 or height < 2:
        raise RuntimeError("帧尺寸异常：%dx%d" % (width, height))

    return {
        "reqId": req.get("reqId"),
        "frames_dir": frames_dir,
        "start": start,
        "count": count,
        "total_frames": total_frames,
        "prompt": prompt,
        "min_score": min_score,
        "min_area": min_area,
        "max_objects": max_objects,
        "out_path": out_path,
        "stride": stride,
        "paths": paths,
        "width": width,
        "height": height,
    }


def handle_auto(req):
    t_start = time.time()
    p = _parse_request(req)
    req_id = p["reqId"]
    start, count = p["start"], p["count"]
    width, height = p["width"], p["height"]
    out_path = p["out_path"]
    min_score, min_area, max_objects = p["min_score"], p["min_area"], p["max_objects"]
    frames_dir = p["frames_dir"]
    total_area = float(width) * float(height)

    log(
        "[auto_worker] reqId=%s framesDir=%s start=%d count=%d total=%d "
        "prompt=%r minScore=%.2f minArea=%g maxObjects=%d stride=%d"
        % (req_id, frames_dir, start, count, p["total_frames"], p["prompt"],
           min_score, min_area, max_objects, p["stride"])
    )
    if p["stride"] != 1:
        # 全自动模式为保标注覆盖，始终逐帧推理；stride 仅保留在协议里，不降采样。
        log("[auto_worker] 注意：auto 模式忽略 stride=%d，始终逐帧处理" % p["stride"])

    frames_out = {start + i: [] for i in range(count)}
    seen_ids = set()
    id_map = {}  # SAM3 obj_id -> 输出 id（1..K，稳定递增）

    def collect(frame_abs, outputs):
        """把一帧的归一化输出转成像素框并过滤。返回本帧框数。"""
        if outputs is None:
            frames_out[frame_abs] = []
            return 0
        ids = outputs.get("out_obj_ids")
        boxes = outputs.get("out_boxes_xywh")
        probs = outputs.get("out_probs")
        if ids is None or boxes is None or probs is None:
            frames_out[frame_abs] = []
            return 0
        rows = []
        for i in range(len(ids)):
            try:
                score = float(probs[i])
            except (TypeError, ValueError):
                continue
            if not (score >= min_score):
                continue
            bb = boxes[i]
            nx, ny, nw, nh = float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])
            x = int(round(nx * width))
            y = int(round(ny * height))
            w = int(round(nw * width))
            h = int(round(nh * height))
            # clamp 到画面内
            x = int(clamp(x, 0, width - 2))
            y = int(clamp(y, 0, height - 2))
            w = int(clamp(w, 1, width - x))
            h = int(clamp(h, 1, height - y))
            if w < 2 or h < 2:
                continue
            if float(w * h) < min_area * total_area:
                continue
            oid = int(ids[i])
            if oid not in id_map:
                id_map[oid] = len(id_map) + 1
            out_id = id_map[oid]
            seen_ids.add(out_id)
            rows.append({
                "id": out_id,
                "x": x, "y": y, "w": w, "h": h,
                "score": round(score, 4),
            })
        rows.sort(key=lambda b: -b["score"])
        rows = rows[:max_objects]
        frames_out[frame_abs] = rows
        return len(rows)

    predictor = get_predictor()

    send({"type": "status", "message": "正在初始化视频会话（%d 帧）…" % count})
    session_id = None
    done = 0
    last_progress = 0
    fps_t0 = None
    frames_received = 0
    frames_tmp_dir = None

    try:
        t_sess = time.time()
        # 用「目录 + 异步帧加载器」开会话：帧常驻 CPU 按需加载，GPU 只放当前帧。
        # 直接传帧列表的话，SAM3 init_state 内部会把整段视频张量搬上 GPU
        # （590 帧约 3.6GB + 模型 3.4GB，8G 卡会塞满并掉速约 10 倍）。
        frames_tmp_dir = _prepare_frame_dir(p["paths"], req_id)
        try:
            resp = predictor.handle_request({
                "type": "start_session",
                "resource_path": frames_tmp_dir,
            })
        except Exception as e:
            log("[auto_worker] 目录/异步帧多次加载会话失败(%r)，回退到帧列表模式（显存占用高）" % e)
            resp = predictor.handle_request({
                "type": "start_session",
                "resource_path": LazyFrames(p["paths"]),
            })
        session_id = resp["session_id"]
        log("[auto_worker] session %s init in %.1fs" % (session_id, time.time() - t_sess))

        send({"type": "status", "message": "正在用文本提示词 %r 检测首帧…" % p["prompt"]})
        t_prompt = time.time()
        resp = predictor.handle_request({
            "type": "add_prompt",
            "session_id": session_id,
            "frame_index": 0,
            "text": p["prompt"],
        })
        n0 = collect(start, resp.get("outputs"))
        done = 1
        frames_received = 1
        log("[auto_worker] first frame prompt in %.1fs -> %d boxes" % (time.time() - t_prompt, n0))
        send({"type": "progress", "reqId": req_id, "done": done, "total": count,
              "found": len(seen_ids)})
        last_progress = done
        fps_t0 = time.time()
        t_frames = 0

        send({"type": "status", "message": "开始逐帧检测+跟踪…"})
        for item in predictor.handle_stream_request({
            "type": "propagate_in_video",
            "session_id": session_id,
            "start_frame_index": 0,
            "max_frame_num_to_track": count,
            "propagation_direction": "forward",
        }):
            frame_index = int(item["frame_index"])
            if frame_index < 0 or frame_index >= count:
                continue
            frame_abs = start + frame_index
            _n = collect(frame_abs, item.get("outputs"))
            t_frames += 1
            frames_received += 1
            # 每 10 帧裁一次 tracker 的旧帧状态：590 帧 × 多人时 SAM3 默认
            # 会把每帧的 maskmem 特征/低分 mask 永久留在内存（实测 CPU 内存 28GB）。
            if frame_index % 10 == 0:
                trim_tracker_outputs(predictor, session_id, frame_index)
            if frame_index + 1 > done:
                done = frame_index + 1
            # 每帧发一次 progress（后端只更新数值，开销可忽略）
            if done - last_progress >= 1:
                send({"type": "progress", "reqId": req_id, "done": done,
                      "total": count, "found": len(seen_ids)})
                last_progress = done
            # 前 20 帧测速后给前端一个预计耗时（done 即已处理帧数）
            if frames_received == 20 and frames_received < count:
                per = (time.time() - fps_t0) / max(1, done - 1)
                remain = (count - done) * per
                send({"type": "status", "message": "已处理 %d/%d 帧，预计还需约 %.1f 分钟…"
                      % (done, count, remain / 60.0)})
                log("[auto_worker] speed %.2f s/frame, ETA %.1f min for %d frames"
                    % (per, remain / 60.0, count))

        elapsed = time.time() - t_start
        box_count = sum(len(boxes) for boxes in frames_out.values())
        # 兜底：若某些帧没收到输出（理论上不会），保持空 boxes 条目
        rows = []
        for f in range(start, start + count):
            rows.append({"frame": f, "boxes": frames_out.get(f, [])})
        data = {
            "frames": rows,
            "meta": {
                "prompt": p["prompt"],
                "startFrame": start,
                "count": count,
                "totalFrames": p["total_frames"],
                "width": width,
                "height": height,
                "minScore": min_score,
                "minArea": min_area,
                "maxObjects": max_objects,
                "temporalDisambiguation": TD,
                "modelLoadSeconds": round(_load_seconds, 1),
                "elapsedMs": int(elapsed * 1000),
            },
        }
        out_dir = os.path.dirname(os.path.abspath(out_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        tmp_path = out_path + ".part"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, out_path)

        elapsed = time.time() - t_start
        log("[auto_worker] done: %d frames, %d boxes, %d objects, %.1fs total, gpu_peak=%.2fGB"
            % (len(rows), box_count, len(seen_ids), elapsed,
               torch_cuda_peak_gb()))
        send({"type": "result", "reqId": req_id, "outPath": out_path,
              "frameCount": len(rows), "boxCount": box_count,
              "objectCount": len(seen_ids)})
    finally:
        if session_id:
            try:
                predictor.handle_request({"type": "close_session", "session_id": session_id})
            except Exception as e:
                log("[auto_worker] close_session 失败: %s" % e)
        if frames_tmp_dir:
            shutil.rmtree(frames_tmp_dir, ignore_errors=True)
        gc.collect()
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass


def torch_cuda_peak_gb():
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.max_memory_allocated() / 1024.0 ** 3
    except Exception:
        pass
    return 0.0


def main():
    send({"type": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            send({"type": "error", "reqId": None, "message": "无法解析请求: %s" % e})
            sys.exit(1)
        req_type = req.get("type")
        if req_type == "ping":
            send({"type": "pong"})
            continue
        if req_type != "auto":
            send({"type": "error", "reqId": req.get("reqId"),
                  "message": "未知请求类型: %s" % req_type})
            sys.exit(1)
        try:
            handle_auto(req)
        except Exception as e:
            import traceback
            log("[auto_worker] FAILED: %r" % e)
            log(traceback.format_exc())
            send({"type": "error", "reqId": req.get("reqId"), "message": str(e)})
            sys.exit(1)
        return
    # stdin 关闭且没有请求
    sys.exit(0)


if __name__ == "__main__":
    main()
