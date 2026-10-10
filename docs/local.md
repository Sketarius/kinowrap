# Local model and upscalers

Kinowrap can run **MiniMax H3 on your own GPU**, for free but slowly, and upscale the results with several AI upscalers. Everything here is optional: nothing changes in Kinowrap until the tools are installed, and none of it is ever offered for MiniMax (API) jobs.

- [What it gives you](#what-it-gives-you)
- [What you need](#what-you-need)
- [Set it up with the script](#set-it-up-with-the-script)
- [Using it in Kinowrap](#using-it-in-kinowrap)
- [How long things take](#how-long-things-take)
- [Upscaling 480p clips to 768p](#upscaling-480p-clips-to-768p)
- [Settings](#settings)
- [Setting it up by hand](#setting-it-up-by-hand)
- [Running h3.py yourself](#running-h3py-yourself)
- [Troubleshooting](#troubleshooting)
- [Adding another upscaler](#adding-another-upscaler)
- [What goes where](#what-goes-where)

## What it gives you

- A **Local (free, slow)** entry in the Model list. It makes **text-to-video, first/last-frame video and reference video** (images, video, audio) with MiniMax H3, quantised to run in 8 GB of VRAM.
- Jobs show in History as **free**: they cost $0 and never count toward your spend, daily limit or Insights. Nothing is sent to MiniMax.
- An **Upscale to 768p** button on finished local 480p clips, with a dropdown of AI upscalers (fast anime models up to the slow, detailed SeedVR2).

The idea: make drafts at 480p with fewer steps, then upscale the ones you like.

## What you need

- An **NVIDIA GPU with 8 GB of VRAM** or more. It was built and tested on an RTX 4060 Laptop (8 GB) with 16 GB of RAM.
- About **40 GB of free disk** for the local model (28 GB of weights, plus 10.5 GB more the first time you use references) and about **10 GB more** if you install every upscaler.
- **Windows or Linux.** The local model and upscalers need an NVIDIA GPU (`h3.py` asks for CUDA), so they aren't available on macOS or on AMD GPUs. **Kinowrap itself, with all the MiniMax features, runs fine on macOS, Linux and Windows**; on a Mac you simply won't see the Local model, and `npm run local -- status` says so.
- **Python 3.11 or 3.12**, **git** and **ffmpeg** on your PATH, and the **NVIDIA driver** (so `nvidia-smi` works).

## Set it up with the script

From the Kinowrap folder:

```bash
npm run local -- status
```

This checks your computer and shows what is and isn't installed:

```
This computer
  ✓ NVIDIA GPU: NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, driver 596.08
  ✓ Python 3.11/3.12: Python 3.12.4
  ...
Local H3 (adds "Local (free, slow)" to the Model list)
  ✓ program: h3.py, Python environment and DiffSynth-Studio
  ✓ text and first/last-frame weights (28 GB) [fl2va]
  ✗ reference weights (images, video, audio) (11 GB) [ref2va]
Upscalers (add choices to the Upscale to 768p dropdown)
  ✓ Real-ESRGAN ...  ✗ Real-CUGAN ...  ✗ waifu2x ...  ✗ SeedVR2 3B ...
```

Then install what you want:

| Command | What it does | Download |
|---|---|---|
| `npm run local -- install h3` | Python environment with CUDA PyTorch, DiffSynth-Studio, and `h3.py`. | about 3 GB of packages |
| `npm run local -- install h3 --weights fl2va` | Also downloads the text and first/last-frame model weights from ModelScope. | 28 GB |
| `npm run local -- install h3 --weights ref2va` | Also downloads the reference weights. | 10.5 GB |
| `npm run local -- install h3 --weights all` | Both sets of weights. | 38.5 GB |
| `npm run local -- install upscaler esrgan` | Real-ESRGAN: Anime / video, Anime / illustration, Live-action / photo. | 46 MB |
| `npm run local -- install upscaler realcugan` | Real-CUGAN: Anime faithful, Anime cleaned up. | 46 MB |
| `npm run local -- install upscaler waifu2x` | waifu2x: Anime gentle. | 36 MB |
| `npm run local -- install upscaler all` | The three programs above. | 128 MB |
| `npm run local -- install seedvr2` | SeedVR2 3B: its own Python environment, the model and its VAE. | about 3 GB of packages + 4.2 GB of models |
| `npm run local -- install all --weights all` | Everything. | about 50 GB |

Options: `--dir <folder>` (where the tools go; default `../h3-local`, or `LOCAL_H3_DIR`), `--cuda cu126` (which PyTorch CUDA build; pick one your driver supports), `--yes` (don't ask before downloading), and `--dry-run` (show exactly what would happen and change nothing).

What to know about it:

- It **asks before every download** and shows the size. In a shell that isn't interactive it refuses unless you pass `--yes`.
- It is **safe to re-run**: anything already installed is skipped, and an out-of-date `h3.py` is refreshed from `local/h3.py`.
- It only writes inside the tools folder. It never touches `server/.env` or `server/data`.
- The model weights are huge, so if a download is interrupted, run the same command again.
- **Restart Kinowrap** afterwards (`npm start`). It looks for the tools when it starts, and only shows what it finds.

Without `--weights`, the H3 weights are not downloaded up front: they download by themselves the first time you run a local job (28 GB, then 10.5 GB the first time a job uses references).

## Using it in Kinowrap

Pick **Local (free, slow)** as the Model. It keeps the page's normal controls:

| Control | Local behaviour |
|---|---|
| **Resolution** | **480P** (832×480 or 480×832) or **768P** (1344×768 or 768×1344), shown as "free". |
| **Aspect ratio** | 16:9 or 9:16. With a first/last frame or references you can also pick **Adaptive**, which follows your first image. |
| **Length** | 1 to 10 seconds at 480p (`LOCAL_H3_MAX_SECONDS`), 1 to 5 seconds at 768p. Lengths snap to the model's frame counts (the real length is printed in the terminal). |
| **Prompt expansion** | Not used locally. |
| **References** | Work as usual: images, video and audio, in the order you list them, with the cast helper. First/last frames and references can't be mixed (they are two different models). |

While a job runs, History shows a progress bar, the step, the time elapsed and about how long is left. The first step is slow and its estimate is rough; it settles after step 2. Before you generate, the price box shows a guess from your last finished job of the same kind and length (the first of each kind has none). Jobs run **one at a time**; the rest wait their turn, and **Cancel** works on queued and running jobs (a running job is stopped and its progress is lost).

The local model reads plain-text prompts like "Image 1 shows Alice" (the cast lines work), but it was trained on a longer structured prompt format for video and audio references, so results with those may be weaker than MiniMax's.

## How long things take

Measured on an RTX 4060 Laptop (8 GB), per denoising step, plus about a minute to encode at the end. The model loads in about 9 seconds.

| Clip | Per step | At 20 steps |
|---|---|---|
| 480p, 1 s, text | about 6 s | about 3 min |
| 480p, 5 s, text | about 52 s | about 18 min |
| 480p, 10 s, text | about 120 s | about 45 min |
| 480p, 1 s, first/last frames | about 16–20 s | about 6 min |
| 480p, 1 s, reference image | about 20 s | about 7 min |
| 480p, 1 s, reference video + audio | about 38 s | about 13 min |
| 480p, 10 s, reference image | about 150 s | about 55 min |
| 768p, 1 s, text | about 22 s | about 8 min |
| 768p, 1 s, reference image | about 32 s | about 11 min |
| 768p, 5 s, text | about 220 s | about 75 min |

Notes:

- **Steps matter linearly.** Halving them halves the time. More steps is generally more refined with diminishing returns (the library's own examples use 50; Kinowrap defaults to 20). Lower `LOCAL_H3_STEPS` for drafts.
- **Some combinations are far too slow.** A 5-second 768p clip with a reference image and reference audio ran for over 20 minutes without finishing step 1 (the GPU's memory was full). Keep 768p clips short, and for anything bigger make it at 480p and upscale.
- Your numbers will differ on other GPUs.

## Upscaling 480p clips to 768p

768p generation is about 3.7 times slower and capped at 5 seconds, so the faster route to a sharper long clip is to **make it at 480p and upscale it**. Each finished local 480p clip has an **Upscale to 768p** button with a dropdown of upscalers (your choice is remembered). The result is scaled to exactly 1344×768 (or 768×1344), keeps the original audio, and is saved as a **new clip**, so you can try several models on the same clip and compare. Upscales are free, run one at a time in the same queue as generation, and show a percentage and time left.

| Choice | Program | Best for | Time per second of video |
|---|---|---|---|
| Anime / video | Real-ESRGAN, 2x | animation and clean footage; made for video | about 3 s |
| Anime, faithful | Real-CUGAN, 2x | animation where you want the least processed look | about 3 s |
| Anime, cleaned up | Real-CUGAN, 2x | animation with noise or blocky compression | about 3 s |
| Anime, gentle | waifu2x, 2x | clean lines, very little invented detail | about 5 s |
| Anime / illustration | Real-ESRGAN, 4x | smooth lines and flat colour | about 16 s |
| Live-action / photo | Real-ESRGAN, 4x | real-looking footage; keeps the most texture | about 45 s |
| SeedVR2 3B (most detail, slow) | SeedVR2 | the most added detail, on any content | about 90 s |

A choice only appears if it is installed (see [the script](#set-it-up-with-the-script)). To keep the programs somewhere else, set `LOCAL_UPSCALERS_DIR`.

**The six ncnn models** (from Real-ESRGAN, Real-CUGAN and waifu2x) are small, fast programs that run through Vulkan and upscale each frame separately. They sharpen and clean the picture, but can't invent detail the clip never had, and fine textures can shimmer slightly between frames.

**SeedVR2** is different: a video diffusion model ([ByteDance, Apache-2.0](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)) that works on whole shots, so it adds much more detail. Kinowrap runs the 3B model in its 8 GB-friendly form (GGUF quantised, with part of the model swapped to system RAM and 512 px VAE tiles). A 2-second clip took about 3 minutes (encode, upscale, decode). The catch: it **redraws** the picture. In a test on a cartoon clip it gave clearly more fur texture and eye detail than the other models, but the eyes also changed from the original drawing, and its frame-to-frame stability was no better than Real-CUGAN's. Try it on a real clip next to the others before relying on it.

None of the upscalers can remove an "AI look" that comes from the generation itself.

## Settings

All in `server/.env` (see `server/.env.example`); restart after changing them.

| Setting | Default | Meaning |
|---|---|---|
| `LOCAL_H3_DIR` | `../h3-local` | Folder with `h3.py` and its `venv`. The Local model is hidden when it isn't there. |
| `LOCAL_H3_STEPS` | `20` | Denoising steps for local jobs. |
| `LOCAL_H3_MAX_SECONDS` | `10` | Longest local clip (768p stays limited to 5). |
| `LOCAL_UPSCALERS_DIR` | `<LOCAL_H3_DIR>/tools` | Folder holding `esrgan`, `realcugan`, `waifu2x` and `seedvr2`. |

## Setting it up by hand

The script does these steps for you; this is the same thing done manually (Windows PowerShell; on Linux use `venv/bin/python`). The folder must be named `h3-local` and sit next to `kinowrap`, or set `LOCAL_H3_DIR`.

```powershell
mkdir h3-local; cd h3-local
python -m venv venv
venv\Scripts\python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
git clone https://github.com/modelscope/DiffSynth-Studio
cd DiffSynth-Studio; ..\venv\Scripts\python.exe -m pip install -e .; cd ..
venv\Scripts\python.exe -m pip install av bitsandbytes modelscope
copy ..\kinowrap\local\h3.py h3.py
venv\Scripts\python.exe -u h3.py "a paper boat on a puddle" --seconds 1 --steps 10
```

The last command downloads the 28 GB of weights the first time and writes a video to `h3-local\outputs`. For the upscalers, unzip each release so the program and its model folders sit directly in `h3-local\tools\<name>` (`esrgan`, `realcugan`, `waifu2x`): [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0) (`realesrgan-ncnn-vulkan-20220424-windows.zip`, the `ubuntu` zip on Linux), [Real-CUGAN](https://github.com/nihui/realcugan-ncnn-vulkan/releases/tag/20220728) (`windows` or `ubuntu`) and [waifu2x](https://github.com/nihui/waifu2x-ncnn-vulkan/releases/tag/20250915) (`windows` or `linux`). For SeedVR2, clone the repo into `h3-local\tools\seedvr2\repo`, make a Python environment in `h3-local\tools\seedvr2\venv` with CUDA PyTorch and `repo\requirements.txt`, and put `seedvr2_ema_3b-Q8_0.gguf` ([cmeka/SeedVR2-GGUF](https://huggingface.co/cmeka/SeedVR2-GGUF)) and `ema_vae_fp16.safetensors` ([numz/SeedVR2_comfyUI](https://huggingface.co/numz/SeedVR2_comfyUI)) in `repo\models\SEEDVR2`.

## Running h3.py yourself

`h3.py` is the only interface Kinowrap uses, and you can run it directly:

```
python h3.py "prompt" --seconds N --steps N --seed N [--vertical | --auto-orient] [--res 480|768]
             [--first image] [--last image] [--ref image:path --ref video:path --ref audio:path ...]
             [--ref-edge 768] [--out file.mp4]
```

- `--first`/`--last` use the first/last-frame weights; any `--ref` switches to the reference weights; the two can't be combined. `--ref` can repeat and keeps its order.
- `--auto-orient` picks portrait or landscape from the first image. `--ref-edge` is the size reference images are resized to (the library default of 2048 is about ten times slower).
- It prints `STEP i/N ...` with elapsed time and time left, a `TIMING` line at the end, and `DONE <path>`. The default output goes to `outputs/<timestamp>_<words>.mp4`.
- It sets `MODELSCOPE_ENDPOINT=https://modelscope.ai` (faster than modelscope.cn for many connections), changes into its own folder (the weights load from `./models`), and reads weights with plain file reads instead of memory-mapping them (see Troubleshooting).

## Troubleshooting

Start with `npm run local -- status`.

| Problem | Fix |
|---|---|
| "Local (free, slow)" isn't in the Model list | The server didn't find `h3.py` and `venv` in `LOCAL_H3_DIR`. Run `npm run local -- status`, then restart Kinowrap. |
| No upscale button, or a choice is missing | Only finished local **480p** clips get it, and only installed choices are listed. Check `status`, then restart Kinowrap. |
| `os error 1455` or "invalid python storage" | Windows ran out of memory it can promise. `h3.py` already avoids memory-mapping the weights, which fixed this here; close other heavy programs and check the Windows paging file isn't tiny. |
| A CUDA out-of-memory error | Close apps that use the GPU, or make the clip shorter or smaller. |
| A job runs for ages and no step finishes | The GPU's memory is full and it is spilling into system memory. Cancel it, and use 480p (then upscale) or a shorter clip. Reference images plus audio at 768p and several seconds are the worst case. |
| Nothing prints for a while | Normal: the first step is slow. Check `nvidia-smi`; if the GPU is at 100% it is working. |
| SeedVR2 runs out of memory or is extremely slow | Kinowrap already uses 512 px tiles and block swapping. Close other GPU programs; if it still fails, use another upscaler for that clip. |
| A crashed run still holds the GPU | A leftover `python` process. End it in Task Manager (or `taskkill /F /IM python.exe` if nothing else is using Python), then retry. |
| `torch._dynamo` "recompile_limit" or "triton not found" warnings | Harmless. |
| A Unicode error when output is redirected to a file | `h3.py` forces UTF-8; make sure you are using the copy in `local/h3.py` (`npm run local -- install h3` refreshes it). |
| The script says a download was refused | You ran it without a terminal and without `--yes`. Add `--yes`. |
| "tar: Cannot connect to C" while unpacking on Windows | Fixed in the script (it calls Windows' own `tar.exe`); update `scripts/local-setup.mjs`. |

## Adding another upscaler

Any command-line upscaler that takes an input and output folder (the ncnn programs do) can be added:

1. Put its files in `h3-local\tools\<name>`.
2. Add an entry to `UPSCALER_CHOICES` in `server/server.mjs`: an `id`, a `label`, its folder (`dir`), program name, the `args` it needs (scale, model name, model folder), a `need` file that proves the model is present, and a rough `perSecond` time. Programs that need frames in and frames out work as they are; anything else (like SeedVR2, which takes a whole video) needs its own branch in `runUpscale`.
3. To make the setup script install it, add it to `UPSCALERS` in `scripts/local-setup.mjs`.

## What goes where

```
h3-local/                       (next to kinowrap/, or LOCAL_H3_DIR)
├── h3.py                       copied from kinowrap/local/h3.py by the script
├── venv/                       Python environment for the local model
├── DiffSynth-Studio/           the library that runs H3
├── models/                     downloaded weights (about 38 GB)
├── outputs/                    clips made by running h3.py yourself
└── tools/
    ├── esrgan/  realcugan/  waifu2x/       small ncnn upscalers
    └── seedvr2/ (repo/, venv/, models)     SeedVR2
kinowrap/
├── local/h3.py                 the launcher (source of truth)
├── scripts/local-setup.mjs     the setup script behind `npm run local`
└── server/data/                clips and the ledger (local clips are named local-*.mp4; upscales local-up-*.mp4)
```
