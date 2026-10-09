"""h3 "description" --seconds N --steps N --vertical --seed N --out file.mp4
         [--first img] [--last img]  [--ref image:path --ref video:path --ref audio:path ...]
Local MiniMax H3 (NF4, pruned) text/first-last-frame/reference to video+audio via DiffSynth-Studio.
Text and first/last frame use the FL2VA weights; any --ref switches to the Ref2VA weights.
Based on examples/minimax_h3/model_inference_low_vram/MiniMax-H3-NF4-Pruned-{FL2VA,Ref2VA}.py
"""
import argparse, os, re, sys, time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)  # weights live in ./models, relative to the cwd
os.environ.setdefault("MODELSCOPE_ENDPOINT", "https://modelscope.ai")
FPS = 24
for _s in (sys.stdout, sys.stderr):  # the libraries print box-drawing characters; cp1252 pipes crash on them
    _s.reconfigure(encoding="utf-8", errors="replace")


def snap_frames(seconds):
    """Frame counts must be 17n+5 (min 22). Snap to the nearest valid count."""
    want = max(1, seconds * FPS)
    n = max(1, round((want - 5) / 17))
    return 17 * n + 5


def load_audio(path, seconds, sample_rate):
    """Decode an audio stream with PyAV (no torchcodec needed). Returns ([C, T] float tensor, rate) or None."""
    import av, numpy as np, torch
    with av.open(path) as c:
        stream = next((s for s in c.streams if s.type == "audio"), None)
        if stream is None:
            return None
        resampler = av.AudioResampler(format="fltp", layout=stream.layout.name, rate=sample_rate)
        chunks = []
        for frame in c.decode(stream):
            for r in resampler.resample(frame):
                chunks.append(r.to_ndarray())
        for r in resampler.resample(None):
            chunks.append(r.to_ndarray())
    if not chunks:
        return None
    wave = np.concatenate(chunks, axis=1)
    if seconds:
        wave = wave[:, : int(seconds * sample_rate)]
    return torch.from_numpy(wave.copy()), sample_rate


def load_references(refs, pipe, num_frames, height, width):
    """[(type, path)] -> the pipeline's reference dicts, in the order given."""
    from PIL import Image
    from diffsynth.utils.data.audio_video import read_video_audio
    sr = pipe.audio_vae.sample_rate
    out = []
    for kind, path in refs:
        if kind == "image":
            out.append({"type": "image", "image": Image.open(path).convert("RGB")})
        elif kind == "video":
            frames, _, _ = read_video_audio(path, height=height, width=width, num_frames=num_frames, fps=FPS, audio_sample_rate=sr)
            sound = load_audio(path, len(frames) / FPS, sr)
            if sound:
                out.append({"type": "video_audio", "video": frames, "audio": sound[0], "sample_rate": sound[1]})
            else:
                out.append({"type": "video", "video": frames})
        else:
            sound = load_audio(path, 15, sr)
            if not sound:
                raise SystemExit(f"No audio found in {path}")
            out.append({"type": "audio", "audio": sound[0], "sample_rate": sound[1]})
    return out


def main():
    ap = argparse.ArgumentParser(prog="h3")
    ap.add_argument("description")
    ap.add_argument("--seconds", type=float, default=1)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--res", type=int, choices=(480, 768), default=480, help="short side in pixels (768 is 1344x768, much slower)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out")
    ap.add_argument("--first", help="first-frame image")
    ap.add_argument("--last", help="last-frame image")
    ap.add_argument("--ref", action="append", default=[], metavar="TYPE:PATH",
                    help="reference, in order: image:path, video:path or audio:path (repeatable)")
    ap.add_argument("--ref-edge", type=int, default=768, help="short edge reference images are resized to (the library default, 2048, is ~10x slower)")
    ap.add_argument("--auto-orient", action="store_true", help="pick portrait/landscape from the first image")
    a = ap.parse_args()
    refs = []
    for r in a.ref:
        kind, _, path = r.partition(":")
        if kind not in ("image", "video", "audio") or not path:
            ap.error(f"--ref needs image:path, video:path or audio:path, got {r!r}")
        refs.append((kind, path))
    if refs and (a.first or a.last):
        ap.error("first/last frames can't be combined with references")
    for p in [a.first, a.last] + [p for _, p in refs]:
        if p and not os.path.isfile(p):
            ap.error(f"file not found: {p}")

    frames = snap_frames(a.seconds)
    vertical = a.vertical
    if a.auto_orient and not vertical:
        from PIL import Image as _I
        pic = a.first or a.last or next((p for k, p in refs if k == "image"), None)
        if pic:
            with _I.open(pic) as im:
                vertical = im.height > im.width
    long_side = {480: 832, 768: 1344}[a.res]
    width, height = (a.res, long_side) if vertical else (long_side, a.res)
    out = a.out
    if not out:
        words = "_".join(re.findall(r"[a-z0-9]+", a.description.lower())[:5]) or "clip"
        out = os.path.join("outputs", f"{datetime.now():%Y%m%d_%H%M%S}_{words}.mp4")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    print(f"requested {a.seconds}s -> {frames} frames = {frames / FPS:.2f}s at {FPS}fps, "
          f"{width}x{height}, {a.steps} steps, seed {a.seed}", flush=True)

    import torch
    from diffsynth.pipelines.minimax_h3_audio_video import MiniMaxH3Pipeline, ModelConfig
    from diffsynth.utils.data.audio_video import write_video_audio

    # Windows: safetensors mmaps the 10-15 GB weight files, and each mapping is charged against commit memory.
    # With ~28 GB of weights that brushes this machine's limit (os error 1455 / "invalid python storage").
    # Read tensors with plain file reads instead: no mapping, no commit charge.
    import json, struct
    from diffsynth.core.vram import disk_map as _dm

    _DT = {"F64": torch.float64, "F32": torch.float32, "F16": torch.float16, "BF16": torch.bfloat16,
           "I64": torch.int64, "I32": torch.int32, "I16": torch.int16, "I8": torch.int8, "U8": torch.uint8,
           "BOOL": torch.bool, "F8_E4M3": torch.float8_e4m3fn, "F8_E5M2": torch.float8_e5m2}

    class _ReadFile:
        def __init__(self, path, framework="pt", device="cpu"):
            self.path, self.device = path, device
            with open(path, "rb") as f:
                n = struct.unpack("<Q", f.read(8))[0]
                self.meta = json.loads(f.read(n))
            self.base = 8 + n
            self.meta.pop("__metadata__", None)

        def keys(self):
            return self.meta.keys()

        def get_tensor(self, name):
            m = self.meta[name]
            a, b = m["data_offsets"]
            with open(self.path, "rb") as f:
                f.seek(self.base + a)
                buf = bytearray(f.read(b - a))
            t = torch.frombuffer(buf, dtype=_DT[m["dtype"]]) if buf else torch.empty(0, dtype=_DT[m["dtype"]])
            t = t.reshape(m["shape"])
            return t.to(self.device) if str(self.device) != "cpu" else t

    _dm.safe_open = _ReadFile

    t0 = time.time()
    vram_config = {
        "offload_dtype": "disk", "offload_device": "disk",
        "onload_dtype": "disk", "onload_device": "disk",
        "preparing_dtype": torch.bfloat16, "preparing_device": "cuda",
        "computation_dtype": torch.bfloat16, "computation_device": "cuda",
    }
    rid = "DiffSynth-Studio/MiniMax-H3-NF4"
    kind = "Ref2VA" if refs else "FL2VA"
    print(f"model: {kind}", flush=True)
    pipe = MiniMaxH3Pipeline.from_pretrained(
        torch_dtype=torch.bfloat16,
        device="cuda",
        model_configs=[
            ModelConfig(model_id=rid, origin_file_pattern=f"minimax-h3-{kind.lower()}-pruned-nf4.safetensors", **vram_config),
            ModelConfig(model_id=rid, origin_file_pattern="minimax-h3-text-encoder-nf4.safetensors", **vram_config),
            ModelConfig(model_id=rid, origin_file_pattern="video_vae_nf4.safetensors", **vram_config),
            ModelConfig(model_id=rid, origin_file_pattern="audio_vae_nf4.safetensors", **vram_config),
        ],
        processor_config=ModelConfig(model_id="MiniMax/MiniMax-H3", origin_file_pattern=f"{kind}/processor/"),
        vram_limit=torch.cuda.mem_get_info("cuda")[1] / (1024 ** 3) - (5 if refs else 2),
    )
    print(f"LOAD_SECONDS {time.time() - t0:.1f}", flush=True)

    step_times = []
    steps_t = {"start": time.time(), "last": time.time()}

    def avg_step():
        # The first step includes warm-up, so once there is a second one, ignore the first.
        return sum(step_times[1:]) / len(step_times[1:]) if len(step_times) > 1 else step_times[0]

    def fmt(sec):
        sec = int(round(sec))
        return f"{sec // 3600}h {sec % 3600 // 60}m" if sec >= 3600 else f"{sec // 60}m {sec % 60:02d}s"

    def progress(timesteps):
        total = len(timesteps)
        steps_t["start"] = steps_t["last"] = time.time()
        for i, t in enumerate(timesteps):
            yield t
            now = time.time()
            step_times.append(now - steps_t["last"])
            steps_t["last"] = now
            elapsed = now - steps_t["start"]
            eta = (total - i - 1) * avg_step()
            print(f"STEP {i + 1}/{total} {step_times[-1]:.1f}s elapsed {elapsed:.0f}s eta {eta:.0f}s"
                  f"  [{fmt(elapsed)} elapsed, about {fmt(eta)} left]", flush=True)

    extra = {}
    if a.first or a.last:
        from PIL import Image
        extra["keyframes"], extra["keyframe_indices"] = [], []
        for path, idx in ((a.first, 0), (a.last, -1)):
            if path:
                extra["keyframes"].append(Image.open(path).convert("RGB"))
                extra["keyframe_indices"].append(idx)
    if refs:
        extra["references"] = load_references(refs, pipe, frames, height, width)
        print(f"loaded {len(refs)} reference(s)", flush=True)

    t1 = time.time()
    video, audio = pipe(
        prompt=a.description, height=height, width=width, num_frames=frames,
        num_inference_steps=a.steps, seed=a.seed, progress_bar_cmd=progress, ref_image_short_edge=a.ref_edge, **extra,
    )
    print(f"GEN_SECONDS {time.time() - t1:.1f}", flush=True)
    write_video_audio(video=video, audio=audio, output_path=out, fps=FPS, audio_sample_rate=32000)
    print(f"PEAK_VRAM_GB {torch.cuda.max_memory_allocated() / 1024 ** 3:.2f}", flush=True)
    print(f"TOTAL_SECONDS {time.time() - t0:.1f}", flush=True)
    if step_times:
        sa = avg_step()
        print(f"TIMING step_seconds {sa:.2f} overhead_seconds {max(0.0, time.time() - t0 - sa * len(step_times)):.1f}", flush=True)
    print(f"DONE {os.path.abspath(out)}", flush=True)


if __name__ == "__main__":
    main()
