# -*- coding: utf-8 -*-
"""SAM3 跟踪工作进程。

通过 stdin/stdout 收发 NDJSON 消息（每行一个 JSON）：
  输入: {"type":"track","reqId":1,"framesDir":"...","startFrame":1,"count":30,
         "totalFrames":1010,"box":{"x":0,"y":0,"w":100,"h":100},"id":1}
         {"type":"ping"}
  输出: {"type":"ready"} / {"type":"status","message":"..."}
         {"type":"progress","reqId":1,"done":5,"total":30}
         {"type":"result","reqId":1,"promptObjId":0,
          "boxes":[{"frame":1,"x":0,"y":0,"w":100,"h":100}, ...]}
         {"type":"error","reqId":1,"message":"..."}
"""
import contextlib
import gc
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BASE = os.path.dirname(_HERE)
REPO = os.path.abspath(
    os.environ.get("SAM3_REPO") or os.path.join(_BASE, "third_party", "sam3")
)
CKPT = os.path.abspath(
    os.environ.get("SAM3_CKPT") or os.path.join(_BASE, "models", "sam3.pt")
)
MAX_FRAMES = 300

# 复制真实 stdout 用于协议输出，再把 fd 1 重定向到 stderr，
# 避免模型/第三方库的 print 污染 NDJSON 协议。
_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

if REPO not in sys.path:
    sys.path.insert(0, REPO)

from PIL import Image  # noqa: E402

_predictor = None


def send(obj):
    _out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _out.flush()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class LazyFrames(list):
    """按需打开帧文件的只读序列，避免一次性把几百帧读进内存。

    继承 list 是因为 SAM3 内部用 isinstance(resource_path, list) 判断帧列表。
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
    global _predictor
    if _predictor is None:
        if not os.path.exists(CKPT):
            raise RuntimeError("找不到模型权重：" + CKPT)
        send({"type": "status", "message": "正在加载 SAM3 模型（首次较慢）…"})
        from sam3.model_builder import build_sam3_video_predictor

        with contextlib.redirect_stdout(sys.stderr):
            # 关闭时域消歧：其默认的 hotstart 缓冲会吞掉前 15 帧输出，
            # 短片段跟踪会全部为空。
            _predictor = build_sam3_video_predictor(
                CKPT, apply_temporal_disambiguation=False
            )
        send({"type": "status", "message": "模型加载完成"})
    return _predictor


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def interpolate_boxes(known, start, count, fill_missing):
    """把关键帧的框线性插值到每一帧。"""
    known = sorted(known, key=lambda b: b["frame"])
    if not known:
        return []
    out = []
    for f in range(start, start + count):
        prev = None
        nxt = None
        for b in known:
            if b["frame"] <= f:
                prev = b
            if b["frame"] >= f and nxt is None:
                nxt = b
            if b["frame"] > f:
                break
        if prev and prev["frame"] == f:
            out.append(dict(prev))
        elif nxt and nxt["frame"] == f:
            out.append(dict(nxt))
        elif prev and nxt and nxt["frame"] > prev["frame"]:
            t = (f - prev["frame"]) / float(nxt["frame"] - prev["frame"])
            out.append({
                "frame": f,
                "x": int(round(prev["x"] + (nxt["x"] - prev["x"]) * t)),
                "y": int(round(prev["y"] + (nxt["y"] - prev["y"]) * t)),
                "w": int(round(prev["w"] + (nxt["w"] - prev["w"]) * t)),
                "h": int(round(prev["h"] + (nxt["h"] - prev["h"]) * t)),
            })
        elif prev and fill_missing:
            out.append({"frame": f, "x": prev["x"], "y": prev["y"], "w": prev["w"], "h": prev["h"]})
        elif nxt:
            out.append({"frame": f, "x": nxt["x"], "y": nxt["y"], "w": nxt["w"], "h": nxt["h"]})
    return out


def handle_track(req):
    req_id = req.get("reqId")
    frames_dir = req["framesDir"]
    start = int(req["startFrame"])
    count = int(req["count"])
    total_frames = int(req.get("totalFrames") or 0)
    box = req["box"]

    if total_frames > 0:
        count = min(count, total_frames - start + 1)
    count = int(clamp(count, 1, MAX_FRAMES))
    stride = int(req.get("stride") or 1)
    stride = int(clamp(stride, 1, 4))

    # 精度档位：stride>1 时只跟踪关键帧，其余帧线性插值
    key_indices = list(range(0, count, stride))
    if key_indices[-1] != count - 1:
        key_indices.append(count - 1)

    paths = [os.path.join(frames_dir, "frame_%06d.jpg" % (start + i)) for i in key_indices]
    for p in paths:
        if not os.path.exists(p):
            raise RuntimeError("缺少帧文件：" + os.path.basename(p))

    predictor = get_predictor()

    with Image.open(paths[0]) as im0:
        img_w, img_h = im0.size

    nx = clamp(float(box["x"]) / img_w, 0.0, 1.0)
    ny = clamp(float(box["y"]) / img_h, 0.0, 1.0)
    nw = clamp(float(box["w"]) / img_w, 0.0, 1.0 - nx)
    nh = clamp(float(box["h"]) / img_h, 0.0, 1.0 - ny)
    if nw <= 1e-4 or nh <= 1e-4:
        raise RuntimeError("提示框太小或超出画面，请重新画框")

    send({"type": "status", "message": "正在初始化视频会话…"})
    session_id = None
    try:
        resp = predictor.handle_request({
            "type": "start_session",
            "resource_path": LazyFrames(paths),
        })
        session_id = resp["session_id"]

        send({"type": "status", "message": "正在根据提示框推理首帧…"})
        resp = predictor.handle_request({
            "type": "add_prompt",
            "session_id": session_id,
            "frame_index": 0,
            "bounding_boxes": [[nx, ny, nw, nh]],
            "bounding_box_labels": [1],
        })
        outputs = resp["outputs"]
        obj_ids = list(outputs["out_obj_ids"])
        probs = list(outputs["out_probs"])
        if not obj_ids:
            raise RuntimeError("提示框未命中目标，请调整框的位置或大小")
        best = max(range(len(obj_ids)), key=lambda i: float(probs[i]))
        prompt_obj_id = int(obj_ids[best])

        key_boxes = []
        if prompt_obj_id in obj_ids:
            i = obj_ids.index(prompt_obj_id)
            bb = outputs["out_boxes_xywh"][i]
            key_boxes.append({
                "frame": start,
                "x": int(round(float(bb[0]) * img_w)),
                "y": int(round(float(bb[1]) * img_h)),
                "w": int(round(float(bb[2]) * img_w)),
                "h": int(round(float(bb[3]) * img_h)),
            })

        done = 1
        send({"type": "progress", "reqId": req_id, "done": done, "total": count})
        key_seen = 1
        for item in predictor.handle_stream_request({
            "type": "propagate_in_video",
            "session_id": session_id,
            "start_frame_index": 0,
            "max_frame_num_to_track": len(paths),
            "propagation_direction": "forward",
        }):
            frame_index = int(item["frame_index"])
            if frame_index == 0:
                continue
            out = item["outputs"]
            ids = list(out["out_obj_ids"])
            if prompt_obj_id in ids:
                j = ids.index(prompt_obj_id)
                bb = out["out_boxes_xywh"][j]
                pos = key_indices[min(frame_index, len(key_indices) - 1)]
                key_boxes.append({
                    "frame": start + pos,
                    "x": int(round(float(bb[0]) * img_w)),
                    "y": int(round(float(bb[1]) * img_h)),
                    "w": int(round(float(bb[2]) * img_w)),
                    "h": int(round(float(bb[3]) * img_h)),
                })
            key_seen += 1
            done = min(count, key_indices[min(key_seen - 1, len(key_indices) - 1)] + 1)
            send({"type": "progress", "reqId": req_id, "done": done, "total": count})

        key_boxes.sort(key=lambda b: b["frame"])
        if stride > 1:
            result = interpolate_boxes(key_boxes, start, count, bool(req.get("fillMissing")))
        else:
            result = key_boxes
        send({"type": "result", "reqId": req_id, "startFrame": start, "total": count,
              "promptObjId": prompt_obj_id, "boxes": result})
    finally:
        if session_id:
            try:
                predictor.handle_request({"type": "close_session", "session_id": session_id})
            except Exception as e:  # 清理失败不影响结果
                log("close_session 失败: %s" % e)
        gc.collect()
        try:
            import torch
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
