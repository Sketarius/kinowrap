# Kinowrap

A local web app for making AI video with [MiniMax](https://www.minimax.io)'s video API. It runs on your own computer, shows the **price before every job**, keeps a **spending ledger**, and checks each request against MiniMax's documented rules before you pay for it. If you have an NVIDIA GPU it can also run a **free local copy of H3** and upscale the results (see [Local model and upscalers](#local-model-and-upscalers-optional)).

> **Unofficial project.** Kinowrap is independent and is not affiliated with or endorsed by MiniMax. "MiniMax" and "H3" are their names, used here only to describe the API and models it talks to. You need your own MiniMax account and API key, and you pay MiniMax directly for what you generate.

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Getting a MiniMax API key](#getting-a-minimax-api-key)
- [Using Kinowrap](#using-kinowrap)
- [Local model and upscalers (optional)](#local-model-and-upscalers-optional)
- [Prices and limits](#prices-and-limits)
- [Spending safety](#spending-safety)
- [Settings](#settings)
- [Where your data lives](#where-your-data-lives)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License](#license)

## What it does

- **Text-to-video, image-to-video and reference-to-video** with the MiniMax H3 and H3 Max models, up to 15 seconds per clip.
- **Price preview and confirmation** before every job, with a line-by-line breakdown.
- **Spending ledger**: a running total, a spending cap, an optional daily limit, a low-balance warning, and a way to sync your real balance.
- **References**: add images, video and audio by link or by uploading files, with MiniMax's limits checked up front.
- **Cast helper**: tell the app which voice belongs to which character and it writes the matching lines into your prompt.
- **History** with search and filters, one-click reuse of past settings (including their references), download, and playback.
- **Longer videos**: continue a clip from its last frame (or use that frame as a reference), then stitch several clips into one video.
- **Upgrade to 2K** for finished H3 clips, **cancel** queued jobs, and **reconcile** your ledger against MiniMax's own records.
- **Library** of saved prompts and reference sets (for example, a character sheet).
- **Optional local model (free, slow):** run H3 on your own NVIDIA GPU with text, first/last-frame and reference input, with progress and time-left, and upscale the results to 768p with a choice of AI upscalers.
- Your API key stays on your computer, in the server. The web page never sees it.

## Requirements

- **macOS, Linux or Windows 11.** Everything except the optional local model works on all three. (Developed on macOS; the launcher has Windows handling and is tested on Windows 11.)
- **[Node.js](https://nodejs.org)**: 20.6 or newer for the server (it reads its settings file with `node --env-file`). The Angular 22 page needs **Node 22.22.3 or newer** (or 24.15+), so install a current LTS. Check with `node -v`.
- **npm** (comes with Node).
- **[ffmpeg](https://ffmpeg.org/download.html)** on your PATH. It's needed for "Continue from last frame", "Last frame as reference", "Stitch" and upscaling. Check with `ffmpeg -version`. On macOS: `brew install ffmpeg`; on Windows: `winget install Gyan.FFmpeg`.
- A modern browser.
- A **MiniMax account with some balance** and a **pay-as-you-go API key** (next section). Not needed if you only use the local model.
- **For the optional local model and upscalers only:** an NVIDIA GPU with 8 GB or more, on Windows or Linux. See [docs/local.md](docs/local.md).

## Quick start

```bash
git clone https://github.com/Sketarius/kinowrap.git
cd kinowrap

# 1. Install the page's dependencies (one time)
npm run setup

# 2. Create your settings file and add your API key (see the next section)
cp server/.env.example server/.env        # Windows PowerShell: copy server\.env.example server\.env
#    then open server/.env in an editor and replace paste-your-key-here with your key

# 3. Start everything
npm start
```

`npm start` runs the server (port 3000) and the page (port 4200), opens your browser at **http://localhost:4200**, and stops both when you press **Ctrl+C**. The first start takes a little longer while Angular builds the page.

**Starting the two parts by hand**, in two terminals:

```bash
cd server && node --env-file=.env server.mjs     # terminal 1
cd client && npm start                            # terminal 2, then open http://localhost:4200
```

Want the free local model too? Run `npm run local -- status` to see what your computer supports and what to install. It's all in [docs/local.md](docs/local.md).

## Getting a MiniMax API key

An API key is a long secret string that lets Kinowrap send jobs to your MiniMax account and charge them to your balance. **Treat it like a password.**

1. **Create an account** on the MiniMax Open Platform: <https://platform.minimax.io>. Kinowrap targets this international platform.
2. **Add some balance.** Go to **Account → Billing → Balance** and top up. Pay-as-you-go keys spend from this balance, so you pay only for what you generate. Start small (a few dollars covers a lot of 4-second test clips). On the same page you can set a **balance alert** so MiniMax emails you when it runs low. That's a good second safety net next to this app's own warnings.
3. **Create a pay-as-you-go API key.** Go to **Account → API Keys** and create a new key. **Copy it right away.** Don't assume you can see it again later.
   - Use a **pay-as-you-go** key. MiniMax also has subscription ("M Plan" / Token Plan) keys under Billing, which draw from a different pool of credits and are not what Kinowrap's pricing is built around. Kinowrap was built and tested with a pay-as-you-go key.
4. **Put the key in your settings file.** Open `server/.env` (created from `server/.env.example` in the quick start) and set:

   ```
   MINIMAX_API_KEY=paste-your-key-here
   ```

   Replace the placeholder with your key. No quotes, no spaces. Save the file, then **restart Kinowrap** (the key is read when the server starts).
5. **Check it works.** Open the app. The balance pill in the top right should appear. Make a 4-second 768p text-only clip (about $0.32) as a first test.

**Keeping the key safe**

- `server/.env` is already listed in `.gitignore`, so git won't commit it. **Never paste your key into a chat, issue, screenshot or commit.**
- MiniMax warns that keys leaked publicly may be disabled automatically. If a key is ever exposed, go to **Account → API Keys**, create a new key, delete the old one, and update `server/.env`.
- Kinowrap's server listens on `127.0.0.1` only, so other devices on your network can't reach it. Don't expose it to the internet: it has no login of its own.

## Using Kinowrap

### 1. Write a prompt

Describe the video in the **Prompt** box. MiniMax accepts up to **7,000 characters**; the counter turns red if you go over. Describing the scene, camera, action, sound and style works best, and time-coded prompts ("0–3 sec: …, 3–6 sec: …") work well for longer clips.

### 2. Choose settings

| Setting | What it does |
|---|---|
| **Model** | **H3** (768p or 2K, 4–15 s) or **H3 Max** (480p or 768p, 5–15 s). If the [local model](#local-model-and-upscalers-optional) is installed, **Local (free, slow)** is listed too. Resolution options and prices follow the model. |
| **Resolution** | Shows the price per second next to each option. |
| **Aspect ratio** | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`. Text-only jobs need a specific ratio. With first/last-frame images the ratio follows your image and the box is locked to "Adaptive". Reference jobs allow either. (Local: 16:9 or 9:16.) |
| **Prompt expansion** | How much MiniMax rewrites your prompt first: `disabled`, `balanced` (MiniMax's default) or `quality`. |
| **Length** | A slider; the allowed range depends on the model. |

The **Mode** line under the settings tells you which of three modes your inputs put you in: *text-to-video*, *image-to-video (first/last frame)* or *reference-to-video*. MiniMax doesn't allow first/last frame images **and** reference media in the same job (outside sources agree, and the local model uses two separate models for them), and the app will tell you if you mix them.

### 3. Add references (optional)

Open **References**. You can add:

- **First frame / Last frame**: images that start or end the clip (image-to-video).
- **Reference images**: up to 9, to keep a character, outfit, place or style consistent.
- **Reference video**: up to 3 clips, 2–15 s each and 15 s in total, to guide motion. Enter the clip's length.
- **Reference audio**: up to 3 clips, 2–15 s each, as a voice or sound guide. Free to use.

Each slot accepts a **public link** (the most reliable option) or a **file from your computer** (sent inline). Notes:

- MiniMax fetches links from its own servers, so the link must be **public and point straight at the file**. Google Drive and Dropbox share links are converted automatically. A link that returns a web page instead of an image is rejected before you're charged.
- A handy free host for images and audio is a **public GitHub repo**: open the file, click **Raw**, and use that address.
- To make MiniMax *use* a reference, say so in the prompt (for example "Image 1 is the main character"). The numbering is explained below.
- Uploaded files are checked for size, length and image dimensions before sending (images 256–5,760 px, up to 30 MB; video up to 50 MB; audio up to 15 MB).
- The **reference status line** above the Generate button always shows how many references are attached. The confirmation dialog repeats it.

### 4. Give each voice to the right character (the cast helper)

MiniMax numbers references **by type, in list order**: "Image 1, Image 2…" and separately "Audio 1, Audio 2…". It has no official field that links a voice to a face, so the only way to say "this voice belongs to this character" is in the prompt.

Each reference row shows its number and has a **Character** box. Type the same name on a character's image and on their voice. With **"Write the cast lines into the start of the prompt for me"** ticked, Kinowrap adds lines like these when you generate:

```
Image 1 shows Alice.
Audio 2 is Alice's voice: use it only when Alice speaks, never for anyone else.
Image 2 shows Bob.
Audio 1 is Bob's voice: use it only when Bob speaks, never for anyone else.
Each voice belongs only to the character it is assigned to.
```

Use the ▲ ▼ arrows to reorder references (a voice only swaps with other voices). The lines update by themselves. A warning appears if a voice has no character, a character has a voice but no image, or an image is left unlabeled. This makes the pairing explicit but can't guarantee MiniMax follows it. **Test with a short clip first**, and keep only the references a scene actually needs.

### 5. Check the price and generate

The price box shows each line (the clip itself, extra images, reference video). **Generate** shows the total. Clicking it opens a confirmation that names the mode and the number of references. Nothing is sent until you confirm. (Local jobs are free; the box shows a rough run time instead once you've made one of that kind.)

### 6. Watch the job

The new job appears in **History** and is checked every 10 seconds. A 15-second 768p clip usually takes a few minutes. When it finishes, the video downloads to your computer and plays in the card; the tab title changes and, if you allowed notifications, you get an alert. Local jobs show a progress bar, the step, the time elapsed and about how long is left.

### 7. History actions

| Button | What it does |
|---|---|
| **Download** | Saves the video file. |
| **Reuse settings** | Loads the prompt, settings **and references** (with their character names) back into the form. |
| **Continue from last frame** | Extracts the clip's final frame and sets it as the first frame of a new job. Keeps the look; motion and audio don't carry over. Frames can't be combined with references. |
| **Last frame as reference** | Extracts the clip's final frame and adds it as a **reference image** (the next free "Image N"; Kinowrap tells you which number, and gives it the character name "the last frame of the previous clip" so the cast lines add "Image N shows the last frame of the previous clip." to your prompt; rename it if you like). The clip's own references, with their character names, are kept, so characters and voices carry over. A looser continuation than the button above, but the one that works together with references. If the clip was itself made from frames, those are dropped and the last frame becomes the only reference. |
| **Upgrade to 2K** | Regenerates a finished H3 768p clip at 2K (clips from the last 7 days). Shows the price first. |
| **Upscale to 768p** | **Local clips only.** Upscales a finished local 480p clip with the AI upscaler chosen in the dropdown beside the button, and saves the result as a new clip. See [docs/local.md](docs/local.md#upscaling-480p-clips-to-768p). |
| **Cancel** | For jobs still queued. MiniMax doesn't charge for cancelled queued tasks, and running MiniMax jobs can't be cancelled. Local jobs can be cancelled while queued or running. |
| **Mark not charged** | For failed jobs MiniMax didn't bill, so your totals stay right. |
| **Delete file** | Removes the downloaded video from your computer; the job and its cost stay in History. |
| **Hide** | Hides a job from the list (spending totals are unchanged). |

Use the search box and the status/model filters to find jobs. A failed job shows MiniMax's reason when it gives one.

### 8. Stitching clips into longer videos

Tick the checkbox on two or more finished clips (up to 10). A bar appears; clips join **in the order you ticked them**. Press **Stitch selected**. The result appears in History as a new video. Stitching happens on your computer with ffmpeg, costs nothing and re-encodes the clips.

A typical long-video workflow: make clip 1, use **Continue from last frame** for clip 2, repeat, then stitch.

### 9. Library

Under the prompt, **Library** saves things you reuse:

- **Save current prompt** (with its references and character names).
- **Save current references as a set** (for example one character's sheet and voice).

Click **Use** to load an item back in.

## Local model and upscalers (optional)

If you have an **NVIDIA GPU with 8 GB or more** (Windows or Linux), Kinowrap can run MiniMax H3 on your own computer: **free, but slow**. A **Local (free, slow)** model appears in the Model list, supports text, first/last-frame and reference input, queues jobs one at a time, shows step-by-step progress and time left, and costs $0 (it never counts toward your spend). Finished 480p local clips can be upscaled to 768p with a dropdown of AI upscalers, from fast anime models to the detailed but slow SeedVR2.

Setting it up is handled by a script:

```bash
npm run local -- status                      # what your computer supports, and what is installed
npm run local -- install h3 --weights all    # the local model (asks before each big download)
npm run local -- install upscaler all        # the three small upscalers
npm run local -- install seedvr2             # the detailed, slow upscaler
```

Everything about it, including speeds, limits, upscaler comparisons, manual setup and troubleshooting, is in **[docs/local.md](docs/local.md)**. On macOS, or without an NVIDIA GPU, none of this is available and nothing else is affected.

## Prices and limits

Prices below are MiniMax's pay-as-you-go rates when this was written. **They can change.** If they do, edit the `MODELS` table at the top of `server/server.mjs`. See <https://platform.minimax.io/docs/guides/pricing-paygo> for current numbers.

| | H3 | H3 Max |
|---|---|---|
| Resolutions and price per second | 768p $0.08, 2K $0.13 | 480p $0.05, 768p $0.08 |
| Clip length | 4–15 s | 5–15 s |
| Images included free | first 5, then $0.04 each | first 2, then $0.074 each |
| Reference video (per second of input) | same as the output rate | 480p $0.0553, 768p $0.143 |
| Reference audio | free | free |

- Upgrading a 768p H3 clip to 2K costs about **$0.10 per second** by the app's reading of MiniMax's pricing page (output plus the original video as input). That is on top of the original clip, so generating at 2K from the start is cheaper if you already know you want 2K.
- Example: a 10-second 768p H3 clip with 3 reference images and 2 audio clips costs **$0.80**.
- The **local model is free** (it uses your own GPU and electricity).

**Limits MiniMax documents** (checked by the app before sending): prompt 7,000 characters; up to 9 reference images, 1 first frame and 1 last frame; up to 3 reference videos and 3 audio clips; 12 reference files in total; reference videos total 15 s; request body 64 MB. The local model follows the same reference limits.

## Spending safety

- **Price before every job**, with a confirmation dialog.
- **Spending cap**: until you sync your balance, the cap is `MAX_SPEND_USD` (default $25). Jobs that would go over are refused.
- **Sync your real balance**: the app can't read your MiniMax balance (MiniMax offers no way to do that for pay-as-you-go keys). Click the **balance pill** in the top right and enter the number shown at **Account → Billing → Balance**. After that, new jobs are subtracted from it.
- **Daily limit** (optional): set `MAX_DAILY_USD`.
- **Low-balance banner** below `LOW_BALANCE_USD` (default $3).
- **Failed jobs**: MiniMax doesn't document whether failed jobs are billed, so the app counts them as spent until you tell it otherwise. Compare against your billing page, then use **Mark not charged**.
- **Insights & reconcile** (at the top): spending per day and per model, and a **Reconcile with MiniMax** button that compares the last 7 days with MiniMax's own task records. It is read-only. It flags cost differences, tasks made outside the app, and failed jobs MiniMax metered nothing for (offering to mark them not charged, after a warning to check your billing page).
- Test prompts with **short 4-second clips** before a long one.
- Local jobs, stitches and upscales are free and are left out of all spending totals.

## Settings

All settings live in `server/.env` (copy from `server/.env.example`). Restart after changing anything.

| Setting | Default | Meaning |
|---|---|---|
| `MINIMAX_API_KEY` | none (required) | Your pay-as-you-go API key. |
| `MAX_SPEND_USD` | `25` | Spending cap used until you sync your balance. |
| `MAX_DAILY_USD` | none | Refuse new jobs past this much spent today. |
| `LOW_BALANCE_USD` | `3` | Show a warning below this balance. |
| `PORT` | `3000` | Server port. If you change it, change `client/proxy.conf.json` too. |
| `MINIMAX_BASE_URL` | `https://api.minimax.io` | MiniMax API address. Kinowrap targets the international platform; other regions are untested. |
| `LOCAL_H3_DIR` | `../h3-local` | Folder with the local model (`h3.py` and its `venv`). The Local model is hidden when it isn't there. |
| `LOCAL_H3_STEPS` | `20` | Denoising steps for local jobs (more is slower). |
| `LOCAL_H3_MAX_SECONDS` | `10` | Longest local clip (local 768p is limited to 5). |
| `LOCAL_UPSCALERS_DIR` | `<LOCAL_H3_DIR>/tools` | Folder holding the upscaler programs. |

## Where your data lives

Everything is stored in `server/data/` on your computer. It is excluded from git, so it never leaves your machine unless you copy it.

| Path | Contents |
|---|---|
| `ledger.json` | Every job and its cost. **Don't delete it**; the spending math uses it. |
| `videos/` | Downloaded and generated videos, including stitched ones (`stitch-*`), local clips (`local-*`) and upscales (`local-up-*`). |
| `frames/` | Last frames extracted for "Continue from last frame" and "Last frame as reference". |
| `refs/` | Copies of files you uploaded as references, so Reuse can bring them back. |
| `library.json` | Your saved prompts and reference sets. |
| `local/` | Temporary working files for a running local job or upscale. Cleared when the job ends. |

Your browser also keeps an unfinished-prompt draft and your upscaler choice in local storage. **Back up `server/data/`** if you care about your history. The local model's own files live outside the project, in the `h3-local` folder (see [docs/local.md](docs/local.md#what-goes-where)).

**What is sent to MiniMax:** your prompt, settings and references. Reference links are fetched by MiniMax's servers; uploaded files are sent inside the request. MiniMax keeps task records for about 7 days. Local jobs send nothing anywhere.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Can't reach the local server" in the page | The server isn't running. Use `npm start`, or start it by hand (see Quick start). |
| `npm start` says a port is in use | Something is already running on 3000 or 4200 (probably an earlier Kinowrap). Stop it with Ctrl+C. |
| `npm start` says `server/.env` is missing | Run `cp server/.env.example server/.env` and add your key. |
| `Missing MINIMAX_API_KEY` | The key line in `server/.env` is empty. (A placeholder is fine if you only use the local model.) |
| `node: bad option: --env-file` | Your Node is too old. Install Node 20.6 or newer. |
| The page won't build: "requires a minimum Node.js version" | Angular 22 needs Node 22.22.3 or newer (or 24.15+). Install a current LTS. |
| "login fail" / HTTP 401 | The key is wrong, was disabled, or is the wrong kind. Create a new **pay-as-you-go** key. |
| "insufficient balance" / HTTP 402 | Top up at **Account → Billing → Balance**, then sync your balance in the app. |
| HTTP 422 "sensitive content" | MiniMax's content check rejected the prompt or a reference. Reword it. |
| HTTP 429 | Rate limit. Wait a bit and try again. |
| "returned text/html instead of image" | The link points at a web page, not the file. Use a direct link (for GitHub, the **Raw** address). |
| The Generate button is greyed out | Look for the red problem list above it, a missing prompt, or a price over your remaining balance. |
| "Continue from last frame", "Last frame as reference", "Stitch" or an upscale fails | Install ffmpeg and make sure `ffmpeg -version` works in the same terminal. |
| Balance in the app looks wrong | Click the balance pill and enter the number from your billing page. |
| A job failed and I can't see why | Open the card's **Raw reply** section. MiniMax doesn't always give a reason. |
| The Local model or an upscaler is missing, or a local job is very slow or fails | See [docs/local.md](docs/local.md#troubleshooting), and run `npm run local -- status`. |

## How it works

```
Browser (Angular page, :4200)  ->  Kinowrap server (127.0.0.1:3000)  ->  MiniMax API (api.minimax.io)
                                                |
                                                +->  local H3 (h3.py on your GPU) and upscalers, one job at a time
```

- **`server/server.mjs`** is a small Node server with no dependencies. It holds the API key, validates every request against MiniMax's rules, keeps the ledger, polls job status, downloads finished videos, and runs ffmpeg for frame extraction and stitching. For local jobs it runs `h3.py` and the upscalers as child processes from a one-at-a-time queue and reads their progress.
- **`client/`** is an Angular page. In development its dev server forwards `/api`, `/videos`, `/frames` and `/refs` to the Kinowrap server (`client/proxy.conf.json`).
- **`start.mjs`** starts both and opens the browser (macOS, Linux and Windows).
- **`local/h3.py`** is the launcher for the local model; **`scripts/local-setup.mjs`** (`npm run local`) installs and checks the local tools.

MiniMax endpoints used: `POST /v2/video_generation`, `GET /v2/query/video_generation/{id}` (and the list form for reconcile), `POST /v2/video_regeneration` (2K upgrade) and `DELETE /v2/video_generation/{id}` (cancel).

## Known limitations

- **No automatic balance.** MiniMax offers no balance API for pay-as-you-go keys, so you sync it by hand.
- **Failed-job billing is undocumented.** The app errs on the side of counting them until you say otherwise.
- **The 2K-upgrade price is the app's reading** of MiniMax's pricing page and may be off.
- **Cast pairing isn't guaranteed.** It improves the odds that voices land on the right characters; it can't force it. One review found generated audio doesn't reproduce your uploaded clip exactly.
- **First/last frames and references can't be combined**, by MiniMax's API (per outside sources; MiniMax's own page for it wasn't found) and by the local model (two separate models).
- **The local model is slow and was measured on one machine** (an RTX 4060 Laptop with 8 GB), so your times will differ. Some large combinations are impractical (see [docs/local.md](docs/local.md#how-long-things-take)). It needs an NVIDIA GPU, so it is Windows and Linux only.
- **Upscalers sharpen but don't create real detail**, and the strongest one (SeedVR2) redraws the picture.
- **Windows** support is new and lightly tested (launcher, page, history, references, stitch, last-frame and the local tools, mostly with a fake key). The setup script's full from-scratch install (Python environment and model downloads) has not been run end to end on a clean machine; the upscaler install and every "already installed" path have.
- **Local only.** There is no login. Don't expose the server to the internet.
- Prices and limits are copied from MiniMax's docs and can change.

## Development

```bash
# the page
cd client && npm install && npm start      # dev server on :4200 with live reload
cd client && npx ng build                  # production build check (the CSS has a small size budget)

# the server, with a fake key (no real requests are made unless you submit a job)
cd server && MINIMAX_API_KEY=fake PORT=3113 node server.mjs
node --check server/server.mjs             # quick syntax check
node --check scripts/local-setup.mjs

# the local tools
npm run local -- status                    # see docs/local.md
npm run local -- install all --dry-run     # shows exactly what the setup script would do
```

To try changes without touching your real data or being charged, run a second copy on other ports with a fake key and a copy of `server/data`, and point a second `ng serve --port 4201 --proxy-config <your-config>` at it. The data folder is fixed next to `server.mjs`, so copy `server.mjs` to a scratch folder with its own `data/`.

Project layout:

```
kinowrap/
├── start.mjs            one-command launcher
├── server/
│   ├── server.mjs       the local server (all API logic, the local queue, the upscalers)
│   ├── .env.example     settings template (copy to .env)
│   └── data/            your data (git-ignored)
├── client/              Angular page (src/app/app.ts, app.html, app.css)
├── local/h3.py          launcher for the local H3 model
├── scripts/local-setup.mjs   setup and status script for the local tools (npm run local)
└── docs/local.md        the full guide to the local model and upscalers
```

## License

[MIT](LICENSE). Copyright (c) 2026 Shane Freeman.
