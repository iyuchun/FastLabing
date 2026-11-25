# -*- coding: utf-8 -*-
"""SAM3 图像模型逐帧文本检测 + IoU 跟踪 worker（长视频/拥挤场景的稳定自动打标后端）。

与 auto_worker.py 使用完全相同的 NDJSON 协议（server.js 无需区分）：
  输入（stdin 一行 JSON）{"type":"auto","reqId":1,"framesDir":...,"startFrame":1,"count":590,
    "totalFrames":590,"prompt":"person","minScore":0.5,"minArea":0.0005,"maxObjects":200,"outPath":...}
  输出（stdout 每行一个 JSON）：ready / status / progress{done,total,found} / result{outPath,...} / error / pong

为什么长视频用图像模型：SAM3 视频跟踪器的跨帧状态在 8G 显存显卡上随帧数/人数累积
（CPU 内存和显存都会涨），590 帧多人场景会掉速甚至 OOM。逐帧图像检测内存恒定，
配合轻量 IoU 追踪即可得到跨帧 ID，速度约 0.8~0.9 s/帧（1080p CPU 端 GPU 推理）。
"""
import json
import os
import sys
import time

# ---------- 协议 stdout 保护（必须在 import 重库之前） ----------
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(
    os.environ.get("SAM3_REPO") or os.path.join(_HERE, "..", "third_party", "sam3")
)
CKPT = os.path.abspath(
    os.environ.get("SAM3_CKPT") or os.path.join(_HERE, "..", "models", "sam3.pt")
)
BPE = os.path.join(REPO, "assets", "bpe_simple_vocab_16e6.txt.gz")


def send(obj):
    _out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _out.flush()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def iou(a, b):
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


class IoUTracker:
    """最近邻 IoU 追踪：与上一帧/前几帧框做贪心 IoU 匹配，未匹配分配新 id。"""

    def __init__(self, iou_thresh=0.15, max_age=3):
        self.thresh = iou_thresh
        self.max_age = max_age
        self.next_id = 1
        self.tracks = {}

    def update(self, dets):
        cands = []
        for di, d in enumerate(dets):
            for tid, tr in self.tracks.items():
                if tr["age"] > self.max_age:
                    continue
                v = iou(d, tr["box"])
                if v >= self.thresh:
                    cands.append((v, di, tid))
        cands.sort(key=lambda x: -x[0])
        assigned = [None] * len(dets)
        used = set()
        for _, di, tid in cands:
            if assigned[di] is not None or tid in used:
                continue
            assigned[di] = tid
            used.add(tid)
        out = []
        new_tracks = {}
        for di, d in enumerate(dets):
            tid = assigned[di]
            if tid is None:
                tid = self.next_id
                self.next_id += 1
            new_tracks[tid] = {"box": d, "age": 0}
            out.append({"id": tid, "x": d["x"], "y": d["y"], "w": d["w"], "h": d["h"],
                        "score": d["score"]})
        for tid, tr in self.tracks.items():
            if tid not in new_tracks:
                tr["age"] += 1
                if tr["age"] <= self.max_age:
                    new_tracks[tid] = tr
        self.tracks = new_tracks
        return out


def parse_request(req):
    frames_dir = req.get("framesDir")
    if not frames_dir or not os.path.isdir(frames_dir):
        raise RuntimeError("帧目录不存在：" + str(frames_dir))
    total = int(req.get("totalFrames") or 0)
    start = max(1, int(req.get("startFrame") or 1))
    if total > 0:
        start = min(start, total)
    count = int(req.get("count") or 0)
    if total > 0:
        count = min(count, total - start + 1)
    if count < 1:
        raise RuntimeError("count 无效（需要 >=1）")
    # 可选：只扫描指定帧（深度质检只检查有标注的帧，跳过空帧可大幅缩短耗时）
    frame_list = None
    raw_frames = req.get("frames")
    if isinstance(raw_frames, list) and raw_frames:
        vals = set()
        for v in raw_frames:
            try:
                n = int(v)
            except Exception:
                continue
            if n < 1 or (total > 0 and n > total):
                continue
            vals.add(n)
        if vals:
            frame_list = sorted(vals)
    return {
        "frames_dir": frames_dir,
        "start": start,
        "count": count,
        "frames": frame_list,
        "prompt": str(req.get("prompt") or "person").strip() or "person",
        "min_score": clamp(float(req.get("minScore", 0.5)), 0.0, 1.0),
        "min_area": max(0.0, float(req.get("minArea", 0.0005))),
        "max_objects": int(clamp(int(req.get("maxObjects") or 200), 1, 2000)),
        "crop": req.get("crop"),
        "out_path": req.get("outPath"),
        "req_id": req.get("reqId"),
    }


def main():
    from PIL import Image
    import torch
    from sam3.model_builder import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    if REPO not in sys.path:
        sys.path.insert(0, REPO)

    send({"type": "ready"})
    line = sys.stdin.readline()
    if not line.strip():
        send({"type": "error", "reqId": None, "message": "未收到任务"})
        return
    req = json.loads(line)
    if req.get("type") == "ping":
        send({"type": "pong"})
        return
    if req.get("type") != "auto":
        send({"type": "error", "reqId": req.get("reqId"), "message": "未知请求类型"})
        return

    try:
        p = parse_request(req)
        if not p["out_path"]:
            raise RuntimeError("缺少 outPath")
        req_id = p["req_id"]
        frames_dir = p["frames_dir"]

        send({"type": "status", "message": "正在加载 SAM3 图像检测模型（约 10 秒）…"})
        t0 = time.time()
        model = build_sam3_image_model(bpe_path=BPE, checkpoint_path=CKPT, device="cuda")
        processor = Sam3Processor(model, device="cuda",
                                  confidence_threshold=min(0.99, p["min_score"]))
        load_s = time.time() - t0
        log("[auto_worker_image] model loaded in %.1fs" % load_s)
        send({"type": "status", "message": "模型加载完成（%.1fs），开始逐帧检测…" % load_s})

        paths = []
        if p["frames"]:
            frame_nums = p["frames"]
        else:
            frame_nums = list(range(p["start"], p["start"] + p["count"]))
        for n in frame_nums:
            fp = os.path.join(frames_dir, "frame_%06d.jpg" % n)
            if not os.path.isfile(fp):
                raise RuntimeError("缺少帧文件：" + os.path.basename(fp))
            paths.append(fp)
        with Image.open(paths[0]) as im:
            W, H = im.size
        total_area = float(W) * float(H)

        # 标注范围：仅在裁剪框内推理（坐标最终会还原到整帧）
        crop_box = None
        crop = p.get("crop")
        if isinstance(crop, dict):
            try:
                cx = int(round(float(crop.get("x") or 0)))
                cy = int(round(float(crop.get("y") or 0)))
                cw = int(round(float(crop.get("w") or 0)))
                ch = int(round(float(crop.get("h") or 0)))
                if cw >= 32 and ch >= 32:
                    cx = max(0, min(W - 32, cx))
                    cy = max(0, min(H - 32, cy))
                    cw = max(32, min(W - cx, cw))
                    ch = max(32, min(H - cy, ch))
                    crop_box = (cx, cy, cw, ch)
            except Exception:
                crop_box = None
        if crop_box:
            send({"type": "status", "message": "仅在划线区域内推理（%d×%d）…"
                  % (crop_box[2], crop_box[3])})

        tracker = IoUTracker()
        frames_out = []
        seen_ids = set()
        t_first = None
        for idx, fp in enumerate(paths):
            with Image.open(fp) as im:
                image = im.convert("RGB")
            if crop_box:
                image = image.crop((crop_box[0], crop_box[1],
                                    crop_box[0] + crop_box[2], crop_box[1] + crop_box[3]))
            state = processor.set_image(image)
            output = processor.set_text_prompt(prompt=p["prompt"], state=state)
            boxes = output["boxes"].detach().float().cpu().tolist()
            scores = output["scores"].detach().float().cpu().tolist()
            ox, oy = (crop_box[0], crop_box[1]) if crop_box else (0, 0)
            dets = []
            for box, score in zip(boxes, scores):
                if float(score) < p["min_score"]:
                    continue
                x1, y1, x2, y2 = (float(v) for v in box[:4])
                x1 = clamp(x1 + ox, 0.0, W - 2.0); y1 = clamp(y1 + oy, 0.0, H - 2.0)
                x2 = clamp(x2 + ox, x1 + 2.0, float(W)); y2 = clamp(y2 + oy, y1 + 2.0, float(H))
                w, h = x2 - x1, y2 - y1
                if w * h < p["min_area"] * total_area:
                    continue
                dets.append({"x": int(round(x1)), "y": int(round(y1)),
                             "w": int(round(w)), "h": int(round(h)),
                             "score": round(float(score), 4)})
            dets.sort(key=lambda b: -b["score"])
            dets = dets[:p["max_objects"]]
            tracked = tracker.update(dets)
            for b in tracked:
                seen_ids.add(b["id"])
            frames_out.append({"frame": frame_nums[idx], "boxes": tracked})
            if idx == 0:
                t_first = time.time()
            if (idx + 1) % 5 == 0 or idx == len(paths) - 1:
                send({"type": "progress", "reqId": req_id, "done": idx + 1,
                      "total": len(paths), "found": len(seen_ids)})
            if (idx + 1) % 50 == 0:
                per = (time.time() - (t_first or t0)) / max(1, idx + 1)
                send({"type": "status", "message": "已处理 %d/%d 帧，预计还需约 %.1f 分钟…"
                      % (idx + 1, len(paths), per * (len(paths) - idx - 1) / 60.0)})

        out_path = p["out_path"]
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        box_count = sum(len(f["boxes"]) for f in frames_out)
        data = {
            "frames": frames_out,
            "meta": {"prompt": p["prompt"], "startFrame": frame_nums[0], "count": len(frame_nums),
                     "totalFrames": len(frame_nums), "width": W, "height": H,
                     "minScore": p["min_score"], "minArea": p["min_area"],
                     "crop": list(crop_box) if crop_box else None,
                     "backend": "sam3_image+iou_tracker",
                     "objectCount": len(seen_ids),
                     "elapsedSec": round(time.time() - t0, 1)},
        }
        tmp = out_path + ".part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, out_path)
        elapsed = time.time() - t0
        log("[auto_worker_image] done: %d frames, %d boxes, %d objects, %.1fs"
            % (len(frames_out), box_count, len(seen_ids), elapsed))
        send({"type": "result", "reqId": req_id, "outPath": out_path,
              "frameCount": len(frames_out), "boxCount": box_count,
              "objectCount": len(seen_ids), "elapsedSec": round(elapsed, 1)})
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
    except Exception as e:
        import traceback
        log("[auto_worker_image] FAILED: %r" % e)
        log(traceback.format_exc())
        send({"type": "error", "reqId": req.get("reqId"), "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
