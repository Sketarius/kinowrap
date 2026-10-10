#!/usr/bin/env node
// Sets up the optional local tools that Kinowrap can use: the local H3 model, and the AI upscalers.
//
//   npm run local -- status
//   npm run local -- install h3 [--weights fl2va|ref2va|all]
//   npm run local -- install upscaler esrgan|realcugan|waifu2x|all
//   npm run local -- install seedvr2
//   npm run local -- install all
//
// Options: --dir <folder>   where the tools live (default: LOCAL_H3_DIR, else ../h3-local next to this project)
//          --cuda cu126     which PyTorch CUDA build to install (default cu126)
//          --yes            don't ask before downloading
//          --dry-run        show what would happen and change nothing
//
// It only writes inside that folder. It never touches server/.env or server/data. Every step is skipped if it is already done,
// and it asks before anything big is downloaded. See docs/local.md.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync, renameSync, chmodSync, readFileSync, statfsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import readline from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const GB = 1024 ** 3;

// ---- options ------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (['dir', 'cuda', 'weights'].includes(argv[i].slice(2))) i++; } else positional.push(argv[i]);
}
const [command, what, which] = positional;
const DRY = flag('dry-run');
const YES = flag('yes');
const CUDA = opt('cuda', 'cu126');
const H3_DIR = path.resolve(opt('dir', process.env.LOCAL_H3_DIR || path.join(root, '..', 'h3-local')));
const TOOLS = path.join(H3_DIR, 'tools');
const venvPython = (dir) => path.join(dir, 'venv', isWin ? 'Scripts/python.exe' : 'bin/python');
const exe = (name) => (isWin ? `${name}.exe` : name);

// ---- what can be installed ----------------------------------------------------------------------

const H3_MODELS = path.join(H3_DIR, 'models');
const H3_REPO_ID = 'DiffSynth-Studio/MiniMax-H3-NF4';
const WEIGHTS = {
  fl2va: {
    label: 'text and first/last-frame weights', sizeGB: 28,
    files: [
      path.join(H3_MODELS, 'DiffSynth-Studio', 'MiniMax-H3-NF4', 'minimax-h3-fl2va-pruned-nf4.safetensors'),
      path.join(H3_MODELS, 'DiffSynth-Studio', 'MiniMax-H3-NF4', 'minimax-h3-text-encoder-nf4.safetensors'),
      path.join(H3_MODELS, 'DiffSynth-Studio', 'MiniMax-H3-NF4', 'video_vae_nf4.safetensors'),
      path.join(H3_MODELS, 'DiffSynth-Studio', 'MiniMax-H3-NF4', 'audio_vae_nf4.safetensors'),
      path.join(H3_MODELS, 'MiniMax', 'MiniMax-H3', 'FL2VA', 'processor'),
    ],
    patterns: [[H3_REPO_ID, 'minimax-h3-fl2va-pruned-nf4.safetensors'], [H3_REPO_ID, 'minimax-h3-text-encoder-nf4.safetensors'], [H3_REPO_ID, 'video_vae_nf4.safetensors'], [H3_REPO_ID, 'audio_vae_nf4.safetensors'], ['MiniMax/MiniMax-H3', 'FL2VA/processor/']],
  },
  ref2va: {
    label: 'reference weights (images, video, audio)', sizeGB: 10.5,
    files: [
      path.join(H3_MODELS, 'DiffSynth-Studio', 'MiniMax-H3-NF4', 'minimax-h3-ref2va-pruned-nf4.safetensors'),
      path.join(H3_MODELS, 'MiniMax', 'MiniMax-H3', 'Ref2VA', 'processor'),
    ],
    patterns: [[H3_REPO_ID, 'minimax-h3-ref2va-pruned-nf4.safetensors'], ['MiniMax/MiniMax-H3', 'Ref2VA/processor/']],
  },
};

// Real-ESRGAN, Real-CUGAN and waifu2x are small ncnn/Vulkan programs from GitHub releases. They need no Python.
const platformZip = (win, linux) => (isWin ? win : linux);
const UPSCALERS = {
  esrgan: {
    name: 'Real-ESRGAN (BSD-3-Clause)', sizeMB: 46, unsupported: process.platform === 'darwin',
    url: `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-${platformZip('windows', 'ubuntu')}.zip`,
    program: 'realesrgan-ncnn-vulkan', check: ['models/realesr-animevideov3-x2.param', 'models/realesrgan-x4plus.param'],
    adds: 'Anime / video, Anime / illustration, Live-action / photo',
  },
  realcugan: {
    name: 'Real-CUGAN (MIT)', sizeMB: 46, unsupported: process.platform === 'darwin',
    url: `https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-${platformZip('windows', 'ubuntu')}.zip`,
    program: 'realcugan-ncnn-vulkan', check: ['models-se/up2x-conservative.param', 'models-se/up2x-denoise2x.param'],
    adds: 'Anime, faithful; Anime, cleaned up',
  },
  waifu2x: {
    name: 'waifu2x (MIT)', sizeMB: 36, unsupported: process.platform === 'darwin',
    url: `https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/20250915/waifu2x-ncnn-vulkan-20250915-${platformZip('windows', 'linux')}.zip`,
    program: 'waifu2x-ncnn-vulkan', check: ['models-cunet/noise1_scale2.0x_model.param'],
    adds: 'Anime, gentle',
  },
};

const SEEDVR2_DIR = path.join(TOOLS, 'seedvr2');
const SEEDVR2 = {
  repoUrl: 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler',
  files: [
    { name: 'seedvr2_ema_3b-Q8_0.gguf', url: 'https://huggingface.co/cmeka/SeedVR2-GGUF/resolve/main/seedvr2_ema_3b-Q8_0.gguf', sizeGB: 3.66 },
    { name: 'ema_vae_fp16.safetensors', url: 'https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/ema_vae_fp16.safetensors', sizeGB: 0.5 },
  ],
};
const seedvr2Models = path.join(SEEDVR2_DIR, 'repo', 'models', 'SEEDVR2');

// ---- helpers ------------------------------------------------------------------------------------

const say = (s = '') => console.log(s);
const tick = (ok) => (ok ? '✓' : '✗');
const fmtGB = (n) => `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} GB`;

function has(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

function findPython() {
  const tries = isWin ? [['py', ['-3.12']], ['py', ['-3.11']], ['python', []]] : [['python3.12', []], ['python3.11', []], ['python3', []]];
  for (const [cmd, pre] of tries) {
    const v = has(cmd, [...pre, '--version']);
    const m = v?.match(/Python 3\.(\d+)/);
    if (m && [11, 12].includes(Number(m[1]))) {
      const exePath = spawnSync(cmd, [...pre, '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
      if (exePath) return { cmd: exePath, version: v };
    }
  }
  return null;
}

function gpu() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [name, mem, driver] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
  return { name, mem, driver };
}

function freeDiskGB(dir) {
  try {
    let probe = dir;
    while (!existsSync(probe)) probe = path.dirname(probe);
    const s = statfsSync(probe);
    return (s.bavail * s.bsize) / GB;
  } catch { return null; }
}

// Runs a command with its output shown. Throws on failure, so the script stops at the first real problem.
function exec(cmd, args, { cwd, env } = {}) {
  say(`  $ ${[cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  if (DRY) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`))));
  });
}

async function confirm(question) {
  if (YES || DRY) return true;
  if (!process.stdin.isTTY) { say(`${question} (not a terminal, so I won't assume yes. Re-run with --yes to allow it.)`); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

async function download(url, dest, label) {
  say(`  downloading ${label} ...`);
  if (DRY) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url} returned HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0, shown = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    if (total && got / total - shown >= 0.1) { shown = got / total; process.stdout.write(`    ${(shown * 100).toFixed(0)}%\n`); }
  });
  await pipeline(body, createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
  say(`  saved ${path.basename(dest)} (${(statSync(dest).size / GB).toFixed(2)} GB)`);
}

function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  // Windows 10+ and macOS ship a tar that reads zip files; elsewhere use unzip.
  // On Windows call the system tar by its full path: under Git Bash a GNU tar can come first and mistakes "C:" for a remote host.
  const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = isWin ? spawnSync(winTar, ['-xf', zip, '-C', dest]) : process.platform === 'darwin' ? spawnSync('tar', ['-xf', zip, '-C', dest]) : spawnSync('unzip', ['-q', '-o', zip, '-d', dest]);
  if (r.status !== 0) throw new Error(`Couldn't unzip ${path.basename(zip)}: ${(r.stderr || '').toString().trim() || 'is unzip installed?'}`);
  // Release zips usually hold one folder; move its contents up so the program sits directly in `dest`.
  const entries = readdirSync(dest);
  if (entries.length === 1 && statSync(path.join(dest, entries[0])).isDirectory()) {
    const inner = path.join(dest, entries[0]);
    for (const e of readdirSync(inner)) renameSync(path.join(inner, e), path.join(dest, e));
    rmSync(inner, { recursive: true, force: true });
  }
}

const filesExist = (list) => list.every((f) => existsSync(f));

// ---- status -------------------------------------------------------------------------------------

function status() {
  const py = findPython();
  const g = gpu();
  const disk = freeDiskGB(H3_DIR);
  say('Kinowrap local tools');
  say(`  folder: ${H3_DIR}`);
  say();
  say('This computer');
  say(`  ${tick(true)} ${os.type()} ${os.release()}, ${(os.totalmem() / GB).toFixed(0)} GB RAM, Node ${process.versions.node}`);
  if (process.platform === 'darwin') {
    say('  - NVIDIA GPU: none (macOS)');
    say();
    say('The local model and the upscalers need an NVIDIA GPU, so they are only available on Windows and Linux.');
    say('Everything else in Kinowrap, including all the MiniMax features, works on macOS. Nothing to set up here.');
    return;
  }
  say(`  ${tick(!!g)} NVIDIA GPU: ${g ? `${g.name}, ${g.mem}, driver ${g.driver}` : 'not found (nvidia-smi failed). Local H3 and SeedVR2 need one.'}`);
  say(`  ${tick(!!py)} Python 3.11/3.12: ${py ? py.version : 'not found'}`);
  say(`  ${tick(!!has('git'))} git: ${has('git') ?? 'not found'}`);
  say(`  ${tick(!!has('ffmpeg', ['-version']))} ffmpeg: ${has('ffmpeg', ['-version'])?.slice(0, 40) ?? 'not found (needed for stitch, last frame and upscaling)'}`);
  say(`  ${tick(disk == null || disk >= 40)} free disk: ${disk == null ? 'unknown' : fmtGB(disk)} (about 40 GB needed for the local model)`);
  say();
  say('Local H3 (adds "Local (free, slow)" to the Model list)');
  const h3ok = existsSync(path.join(H3_DIR, 'h3.py')) && existsSync(venvPython(H3_DIR)) && existsSync(path.join(H3_DIR, 'DiffSynth-Studio'));
  say(`  ${tick(h3ok)} program: h3.py, Python environment and DiffSynth-Studio`);
  for (const [id, w] of Object.entries(WEIGHTS)) say(`  ${tick(filesExist(w.files))} ${w.label} (${fmtGB(w.sizeGB)}) [${id}]`);
  say();
  say('Upscalers (add choices to the Upscale to 768p dropdown)');
  for (const [id, u] of Object.entries(UPSCALERS)) {
    const dir = path.join(TOOLS, id);
    say(`  ${tick(existsSync(path.join(dir, exe(u.program))) && filesExist(u.check.map((c) => path.join(dir, c))))} ${u.name}: ${u.adds} [${id}]`);
  }
  const sv = existsSync(venvPython(SEEDVR2_DIR)) && existsSync(path.join(SEEDVR2_DIR, 'repo', 'inference_cli.py')) && filesExist(SEEDVR2.files.map((f) => path.join(seedvr2Models, f.name)));
  say(`  ${tick(sv)} SeedVR2 3B: most detail, slow (about 90 s per second of video) [seedvr2]`);
  say();
  say('Install what is missing with:  npm run local -- install <h3 | upscaler <name|all> | seedvr2 | all>');
  say('Restart Kinowrap afterwards so it notices.');
}

// ---- install steps ------------------------------------------------------------------------------

async function pipInstallTorch(python, cwd) {
  await exec(python, ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio', '--index-url', `https://download.pytorch.org/whl/${CUDA}`], { cwd });
}

async function makeVenv(dir, py) {
  if (existsSync(venvPython(dir))) { say('  Python environment already exists, keeping it.'); return false; }
  await exec(py.cmd, ['-m', 'venv', 'venv'], { cwd: dir });
  await exec(venvPython(dir), ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: dir });
  return true;
}

async function installH3(weights) {
  say('== Local H3');
  const py = findPython();
  if (!py) throw new Error('Python 3.11 or 3.12 was not found. Install one (python.org) and try again.');
  if (!gpu()) say('  warning: no NVIDIA GPU found with nvidia-smi. Local H3 will not run without one.');
  if (!has('git')) throw new Error('git was not found.');
  const needWeights = (weights === 'all' ? ['fl2va', 'ref2va'] : weights ? [weights] : []).filter((w) => WEIGHTS[w]);
  if (weights && !needWeights.length) throw new Error('--weights must be fl2va, ref2va or all.');

  const missingWeights = needWeights.filter((w) => !filesExist(WEIGHTS[w].files));
  const gb = missingWeights.reduce((s, w) => s + WEIGHTS[w].sizeGB, 0);
  say(`  folder: ${H3_DIR}`);
  say(`  plan: Python environment with CUDA PyTorch (about 3 GB), DiffSynth-Studio from GitHub, h3.py${missingWeights.length ? `, and ${fmtGB(gb)} of model weights from ModelScope (${missingWeights.join(' + ')})` : ''}`);
  if (!existsSync(venvPython(H3_DIR)) || !existsSync(path.join(H3_DIR, 'DiffSynth-Studio')) || missingWeights.length) {
    if (!(await confirm('  Go ahead?'))) { say('  skipped.'); return; }
  }
  if (!DRY) mkdirSync(H3_DIR, { recursive: true });

  if (await makeVenv(H3_DIR, py)) await pipInstallTorch(venvPython(H3_DIR), H3_DIR);
  const ds = path.join(H3_DIR, 'DiffSynth-Studio');
  if (!existsSync(ds)) {
    await exec('git', ['clone', 'https://github.com/modelscope/DiffSynth-Studio'], { cwd: H3_DIR });
    await exec(venvPython(H3_DIR), ['-m', 'pip', 'install', '-e', '.'], { cwd: ds });
    await exec(venvPython(H3_DIR), ['-m', 'pip', 'install', 'av', 'bitsandbytes', 'modelscope'], { cwd: H3_DIR });
  } else say('  DiffSynth-Studio already installed, keeping it.');

  const src = path.join(root, 'local', 'h3.py');
  const dst = path.join(H3_DIR, 'h3.py');
  if (!existsSync(dst) || readFileSync(src, 'utf8') !== readFileSync(dst, 'utf8')) {
    say(`  copying h3.py (${existsSync(dst) ? 'updating the older copy' : 'new'})`);
    if (!DRY) copyFileSync(src, dst);
  } else say('  h3.py is up to date.');

  for (const w of missingWeights) {
    say(`  downloading the ${WEIGHTS[w].label} (${fmtGB(WEIGHTS[w].sizeGB)}); this takes a while and happens once ...`);
    const code = [
      'import os, sys',
      'os.environ.setdefault("MODELSCOPE_ENDPOINT", "https://modelscope.ai")',
      'from diffsynth.pipelines.minimax_h3_audio_video import ModelConfig',
      `for rid, pat in ${JSON.stringify(WEIGHTS[w].patterns)}:`,
      '    ModelConfig(model_id=rid, origin_file_pattern=pat).download_if_necessary()',
      '    print("downloaded", pat, flush=True)',
    ].join('\n');
    await exec(venvPython(H3_DIR), ['-u', '-c', code], { cwd: H3_DIR, env: { PYTHONIOENCODING: 'utf-8' } });
  }
  if (!weights) say('  Weights are not downloaded yet. They download by themselves on the first local job, or run:  npm run local -- install h3 --weights all');
  say('  done.');
}

async function installUpscaler(id) {
  const u = UPSCALERS[id];
  say(`== ${u.name}`);
  if (u.unsupported) { say('  not available for this system.'); return; }
  const dir = path.join(TOOLS, id);
  if (existsSync(path.join(dir, exe(u.program))) && filesExist(u.check.map((c) => path.join(dir, c)))) { say('  already installed.'); return; }
  say(`  download: ${path.basename(new URL(u.url).pathname)} (about ${u.sizeMB} MB) -> ${dir}`);
  if (!(await confirm('  Go ahead?'))) { say('  skipped.'); return; }
  const zip = path.join(os.tmpdir(), path.basename(new URL(u.url).pathname));
  await download(u.url, zip, id);
  if (!DRY) {
    rmSync(dir, { recursive: true, force: true });
    extractZip(zip, dir);
    rmSync(zip, { force: true });
    if (!isWin) chmodSync(path.join(dir, u.program), 0o755);
    if (!existsSync(path.join(dir, exe(u.program))) || !filesExist(u.check.map((c) => path.join(dir, c)))) throw new Error(`${id} was unpacked but the expected files are missing. Look in ${dir}.`);
  }
  say('  done.');
}

async function installSeedvr2() {
  say('== SeedVR2 3B (video diffusion upscaler, Apache-2.0)');
  const py = findPython();
  if (!py) throw new Error('Python 3.11 or 3.12 was not found.');
  if (!has('git')) throw new Error('git was not found.');
  if (!gpu()) say('  warning: no NVIDIA GPU found with nvidia-smi. SeedVR2 will not run without one.');
  const repo = path.join(SEEDVR2_DIR, 'repo');
  const missing = SEEDVR2.files.filter((f) => !existsSync(path.join(seedvr2Models, f.name)));
  const needEnv = !existsSync(venvPython(SEEDVR2_DIR));
  if (!needEnv && existsSync(path.join(repo, 'inference_cli.py')) && !missing.length) { say('  already installed.'); return; }
  say(`  folder: ${SEEDVR2_DIR}`);
  say(`  plan: git clone of ${SEEDVR2.repoUrl}, its own Python environment (about 3 GB of packages)${missing.length ? `, and ${fmtGB(missing.reduce((s, f) => s + f.sizeGB, 0))} of model files from Hugging Face (${missing.map((f) => f.name).join(', ')})` : ''}`);
  if (!(await confirm('  Go ahead?'))) { say('  skipped.'); return; }
  if (!DRY) mkdirSync(SEEDVR2_DIR, { recursive: true });
  if (!existsSync(repo)) await exec('git', ['clone', SEEDVR2.repoUrl, 'repo'], { cwd: SEEDVR2_DIR });
  if (needEnv) {
    await makeVenv(SEEDVR2_DIR, py);
    await pipInstallTorch(venvPython(SEEDVR2_DIR), SEEDVR2_DIR);
    await exec(venvPython(SEEDVR2_DIR), ['-m', 'pip', 'install', '-r', path.join('repo', 'requirements.txt')], { cwd: SEEDVR2_DIR });
  }
  for (const f of missing) await download(f.url, path.join(seedvr2Models, f.name), `${f.name} (${fmtGB(f.sizeGB)})`);
  say('  done.');
}

// ---- main ---------------------------------------------------------------------------------------

function usage() {
  say('Usage:');
  say('  npm run local -- status');
  say('  npm run local -- install h3 [--weights fl2va|ref2va|all]');
  say('  npm run local -- install upscaler <esrgan|realcugan|waifu2x|all>');
  say('  npm run local -- install seedvr2');
  say('  npm run local -- install all [--weights all]');
  say('Options: --dir <folder>  --cuda cu126  --yes  --dry-run');
  say('Docs: docs/local.md');
}

try {
  if (command === 'install' && process.platform === 'darwin') {
    throw new Error('The local model and upscalers need an NVIDIA GPU, so they are only available on Windows and Linux. Everything else in Kinowrap, including all the MiniMax features, works on macOS.');
  }
  if (command === 'status') status();
  else if (command === 'install' && what === 'h3') await installH3(opt('weights'));
  else if (command === 'install' && what === 'upscaler' && (which === 'all' || UPSCALERS[which])) {
    for (const id of which === 'all' ? Object.keys(UPSCALERS) : [which]) await installUpscaler(id);
  } else if (command === 'install' && what === 'seedvr2') await installSeedvr2();
  else if (command === 'install' && what === 'all') {
    await installH3(opt('weights'));
    for (const id of Object.keys(UPSCALERS)) await installUpscaler(id);
    await installSeedvr2();
  } else { usage(); process.exitCode = command ? 1 : 0; }
  if (command === 'install') say('\nRestart Kinowrap (npm start) so it notices the new tools. Check with:  npm run local -- status');
} catch (e) {
  console.error(`\nStopped: ${e.message}`);
  process.exit(1);
}
