# -*- coding: utf-8 -*-
"""SAM2.1 跟踪工作进程（框提示视频跟踪）。

协议与 sam3_worker.py 一致，按行收发 JSON：
  输入: {"type":"track","reqId":1,"framesDir":"...","startFrame":1,"count":30,
         "totalFrames":1010,"box":{"x":0,"y":0,"w":100,"h":100},"id":1,"fillMissing":true}
  输出: {"type":"ready"} / {"type":"status","message":"..."}
         {"type":"progress","reqId":1,"done":5,"total":30}
         {"type":"result","reqId":1,"boxes":[{"frame":1,"x":0,"y":0,"w":100,"h":100}, ...]}
         {"type":"error","reqId":1,"message":"..."}
"""
import contextlib
import gc
import json
import os
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BASE = os.path.dirname(_HERE)
CKPT = os.path.abspath(
    os.environ.get("SAM2_CKPT") or os.path.join(_BASE, "models", "sam2.1_hiera_tiny.pt")
)
CONFIG = os.environ.get("SAM2_CONFIG", "configs/sam2.1/sam2.1_hiera_t.yaml")
TMP_ROOT = os.environ.get("SAM2_TMP_DIR", "")
MAX_FRAMES = 300

# 复制真实 stdout 用于协议输出，再把 fd 1 重定向到 stderr，
# 避免模型/第三方库的 print、进度条污染 NDJSON 协议。
_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

_predictor = None


def send(obj):
    _out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _out.flush()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get_predictor():
    global _predictor
    if _predictor is None:
        if not os.path.exists(CKPT):
            raise RuntimeError("找不到 SAM2 权重：" + CKPT)
        send({"type": "status", "message": "正在加载 SAM2.1 模型…"})
        from sam2.build_sam import build_sam2_video_predictor

        with contextlib.redirect_stdout(sys.stderr):
            _predictor = build_sam2_video_predictor(
                CONFIG, CKPT, device="cuda", apply_postprocessing=False
            )
        send({"type": "status", "message": "SAM2.1 模型加载完成"})
    return _predictor


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def mask_to_box(mask, img_w, img_h):
    arr = mask.detach().cpu().numpy() if hasattr(mask, "detach") else np.asarray(mask)
    while arr.ndim > 2:
        arr = arr[0]
    ys, xs = np.nonzero(arr > 0.0)
    if not len(xs):
        return None
    x1, x2 = int(xs.min()), int(xs.max())
    y1, y2 = int(ys.min()), int(ys.max())
    x = clamp(x1, 0, img_w - 1)
    y = clamp(y1, 0, img_h - 1)
    w = clamp(x2 - x1, 1, img_w - x)
    h = clamp(y2 - y1, 1, img_h - y)
    if w < 2 or h < 2:
        return None
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}


def prepare_frames(frames_dir, start, count, tmp_dir):
    """用硬链接（失败则复制）把需要的帧放进临时目录，文件名按序排列。"""
    os.makedirs(tmp_dir, exist_ok=True)
    total = 0
    for i in range(count):
        src = os.path.join(frames_dir, "frame_%06d.jpg" % (start + i))
        if not os.path.exists(src):
            raise RuntimeError("缺少帧文件：" + os.path.basename(src))
        dst = os.path.join(tmp_dir, "%05d.jpg" % (i + 1))
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
        total += 1
    return total


def handle_track(req):
    import torch

    req_id = req.get("reqId")
    frames_dir = req["framesDir"]
    start = int(req["startFrame"])
    count = int(req["count"])
    total_frames = int(req.get("totalFrames") or 0)
    box = req["box"]

    if total_frames > 0:
        count = min(count, total_frames - start + 1)
    count = int(clamp(count, 1, MAX_FRAMES))

    tmp_root = TMP_ROOT or os.path.join(frames_dir, "..", "..", "tmp")
    tmp_dir = os.path.abspath(os.path.join(tmp_root, "sam2_%d_%s" % (os.getpid(), req_id)))
    state = None
    try:
        send({"type": "status", "message": "正在准备帧序列…"})
        prepare_frames(frames_dir, start, count, tmp_dir)
        with Image.open(os.path.join(frames_dir, "frame_%06d.jpg" % start)) as im0:
            img_w, img_h = im0.size

        predictor = get_predictor()
        send({"type": "status", "message": "正在初始化视频会话…"})
        state = predictor.init_state(video_path=tmp_dir, offload_video_to_cpu=True)

        x1 = clamp(float(box["x"]), 0, img_w - 2)
        y1 = clamp(float(box["y"]), 0, img_h - 2)
        x2 = clamp(float(box["x"]) + float(box["w"]), x1 + 1, img_w)
        y2 = clamp(float(box["y"]) + float(box["h"]), y1 + 1, img_h)

        send({"type": "status", "message": "正在根据提示框推理首帧…"})
        frame_idx, obj_ids, masks = predictor.add_new_points_or_box(
            state, frame_idx=0, obj_id=1,
            box=np.array([x1, y1, x2, y2], dtype=np.float32),
        )
        boxes = {}
        bb = mask_to_box(masks[0], img_w, img_h)
        if bb is None:
            raise RuntimeError("提示框未命中目标，请调整框的位置或大小")
        boxes[start] = bb

        done = 1
        send({"type": "progress", "reqId": req_id, "done": done, "total": count})

        for fi, ids, masks in predictor.propagate_in_video(
            state, start_frame_idx=0,
            max_frame_num_to_track=count - 1, reverse=False,
        ):
            fi = int(fi)
            if fi == 0:
                continue
            bb = mask_to_box(masks[0], img_w, img_h)
            if bb is not None:
                boxes[start + fi] = bb
            done += 1
            send({"type": "progress", "reqId": req_id, "done": done, "total": count})

        result = [{"frame": f, **b} for f, b in sorted(boxes.items())]
        send({"type": "result", "reqId": req_id, "startFrame": start,
              "total": count, "boxes": result})
    finally:
        if state is not None:
            try:
                predictor.reset_state(state)
            except Exception as e:
                log("reset_state 失败: %s" % e)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        gc.collect()
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass


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
            continue
        req_type = req.get("type")
        if req_type == "ping":
            send({"type": "pong"})
            continue
        if req_type != "track":
            send({"type": "error", "reqId": req.get("reqId"), "message": "未知请求类型: %s" % req_type})
            continue
        try:
            handle_track(req)
        except Exception as e:
            log("track 失败: %r" % e)
            send({"type": "error", "reqId": req.get("reqId"), "message": str(e)})


if __name__ == "__main__":
    main()
