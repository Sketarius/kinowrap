// Kinowrap's local server: a proxy for the MiniMax video API. Holds the API key, enforces the documented request rules
// and a spend cap, and keeps a ledger so the browser never sees the key.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const run = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const OUT_DIR = path.join(DATA_DIR, 'videos');
const LEDGER = path.join(DATA_DIR, 'ledger.json');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const LIBRARY = path.join(DATA_DIR, 'library.json');
const REFS_DIR = path.join(DATA_DIR, 'refs');

const API_KEY = process.env.MINIMAX_API_KEY;
const BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io';
const MAX_SPEND = Number(process.env.MAX_SPEND_USD || 25);
const PORT = Number(process.env.PORT || 3000);
const LOW_BALANCE = Number(process.env.LOW_BALANCE_USD || 3);
const MAX_DAILY = Number(process.env.MAX_DAILY_USD || 0); // 0 = no daily cap

if (!API_KEY) {
  console.error('Missing MINIMAX_API_KEY. Copy .env.example to .env and set it.');
  process.exit(1);
}

const MB = 1024 * 1024;

// USD prices from platform.minimax.io/docs/guides/pricing-paygo.
const MODELS = {
  'MiniMax-H3': {
    label: 'H3',
    minSeconds: 4,
    rates: { '768P': 0.08, '2K': 0.13 },
    refVideoRates: { '768P': 0.08, '2K': 0.13 },
    freeImages: 5,
    extraImage: 0.04,
  },
  'MiniMax-H3-Max': {
    label: 'H3 Max',
    minSeconds: 5,
    rates: { '480P': 0.05, '768P': 0.08 },
    refVideoRates: { '480P': 0.0553, '768P': 0.143 },
    freeImages: 2,
    extraImage: 0.074,
  },
};
// 768P -> 2K regeneration. As read from the pricing page: output seconds plus the source video as input.
const UPGRADE = { outputRate: 0.05, inputVideoRate: 0.05, freeImages: 5, extraImage: 0.025 };
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const EXPANSION = ['disabled', 'balanced', 'quality'];
const LIMITS = {
  prompt: 7000, referenceImages: 9, videos: 3, audios: 3, totalFiles: 12,
  clipMin: 2, clipMax: 15, videoTotalSeconds: 15, audioTotalSeconds: 15,
  imageBytes: 30 * MB, videoBytes: 50 * MB, audioBytes: 15 * MB, requestBytes: 64 * MB,
};
const UPGRADE_WINDOW_DAYS = 7;

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.mkdir(FRAMES_DIR, { recursive: true });
await fs.mkdir(REFS_DIR, { recursive: true });

async function readLedger() {
  try {
    return JSON.parse(await fs.readFile(LEDGER, 'utf8'));
  } catch {
    return { jobs: [] };
  }
}
const writeLedger = (l) => fs.writeFile(LEDGER, JSON.stringify(l, null, 2));
const round = (n) => Math.round(n * 100) / 100;
const isBilled = (j) => !j.refunded;
const totalSpent = (l) => l.jobs.filter(isBilled).reduce((s, j) => s + j.cost, 0);
// After a manual balance sync, only jobs created since then count against the synced amount.
function remainingOf(l) {
  if (l.balanceSync) {
    const since = l.jobs.filter((j) => isBilled(j) && j.createdAt > l.balanceSync.at).reduce((s, j) => s + j.cost, 0);
    return round(l.balanceSync.amount - since);
  }
  return round(MAX_SPEND - totalSpent(l));
}

const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD in your timezone
const spentToday = (l) => l.jobs.filter((j) => isBilled(j) && localDay(j.createdAt) === localDay(new Date().toISOString())).reduce((s, j) => s + j.cost, 0);

// ---- request rules -------------------------------------------------------------------------

const dataUrlBytes = (url) => (url.startsWith('data:') ? Math.ceil((url.length * 3) / 4) : 0);

// refs: [{ type: 'image'|'video'|'audio', role, url, seconds? }]
// Returns the validated plan: { modelName, model, mode, ratio, refs }.
function plan(body) {
  const modelName = body.model || 'MiniMax-H3';
  const model = MODELS[modelName];
  if (!model) throw new Error(`Unknown model: ${modelName}`);
  const refs = body.refs || [];
  if (typeof body.prompt === 'string' && body.prompt.length > LIMITS.prompt) {
    throw new Error(`Prompt is ${body.prompt.length} characters; the limit is ${LIMITS.prompt}.`);
  }

  const frames = refs.filter((r) => r.role === 'first_frame' || r.role === 'last_frame');
  const media = refs.filter((r) => ['reference_image', 'reference_video', 'reference_audio'].includes(r.role));
  if (frames.length && media.length) {
    throw new Error("First/last frame images can't be combined with reference images, video or audio. Use one or the other.");
  }
  const mode = frames.length ? 'i2v' : media.length ? 'r2v' : 't2v';

  const count = (role) => refs.filter((r) => r.role === role).length;
  if (count('first_frame') > 1 || count('last_frame') > 1) throw new Error('Only one first frame and one last frame are allowed.');
  if (count('reference_image') > LIMITS.referenceImages) throw new Error(`At most ${LIMITS.referenceImages} reference images.`);
  if (count('reference_video') > LIMITS.videos) throw new Error(`At most ${LIMITS.videos} reference videos.`);
  if (count('reference_audio') > LIMITS.audios) throw new Error(`At most ${LIMITS.audios} reference audio clips.`);
  if (media.length > LIMITS.totalFiles) throw new Error(`At most ${LIMITS.totalFiles} reference files in total.`);

  const videos = refs.filter((r) => r.type === 'video');
  const audios = refs.filter((r) => r.type === 'audio');
  for (const v of videos) {
    const s = Number(v.seconds);
    if (!(s >= LIMITS.clipMin && s <= LIMITS.clipMax)) throw new Error(`Each reference video needs a length of ${LIMITS.clipMin}-${LIMITS.clipMax} seconds.`);
  }
  if (videos.reduce((t, v) => t + Number(v.seconds), 0) > LIMITS.videoTotalSeconds) {
    throw new Error(`Reference videos can total at most ${LIMITS.videoTotalSeconds} seconds.`);
  }
  for (const a of audios) {
    if (a.seconds != null && a.seconds !== '' && !(Number(a.seconds) >= LIMITS.clipMin && Number(a.seconds) <= LIMITS.clipMax)) {
      throw new Error(`Each reference audio clip must be ${LIMITS.clipMin}-${LIMITS.clipMax} seconds.`);
    }
  }
  if (audios.length && audios.every((a) => a.seconds)) {
    if (audios.reduce((t, a) => t + Number(a.seconds), 0) > LIMITS.audioTotalSeconds) {
      throw new Error(`Reference audio can total at most ${LIMITS.audioTotalSeconds} seconds.`);
    }
  }

  let bytes = 0;
  for (const r of refs) {
    const b = dataUrlBytes(r.url);
    const cap = r.type === 'image' ? LIMITS.imageBytes : r.type === 'video' ? LIMITS.videoBytes : LIMITS.audioBytes;
    if (b > cap) throw new Error(`An uploaded ${r.type} is ${(b / MB).toFixed(1)} MB; the limit is ${cap / MB} MB.`);
    bytes += b;
  }
  if (bytes > LIMITS.requestBytes) throw new Error(`Uploaded files total ${(bytes / MB).toFixed(1)} MB; the request limit is ${LIMITS.requestBytes / MB} MB. Use URLs for large files.`);

  let ratio = body.ratio;
  if (mode === 'i2v') ratio = 'adaptive';
  else if (mode === 't2v' && !RATIOS.includes(ratio)) throw new Error('Text-to-video needs a specific aspect ratio (not adaptive).');
  else if (mode === 'r2v' && ratio !== 'adaptive' && !RATIOS.includes(ratio)) throw new Error(`Unsupported aspect ratio: ${ratio}`);

  return { modelName, model, mode, ratio, refs };
}

function estimate(body) {
  const { model, mode, ratio, refs } = plan(body);
  const { duration, resolution } = body;
  const rate = model.rates[resolution];
  if (!rate) throw new Error(`${model.label} supports ${Object.keys(model.rates).join(' or ')}, not ${resolution}.`);
  if (!Number.isInteger(duration) || duration < model.minSeconds || duration > 15) {
    throw new Error(`${model.label} clips must be a whole number of seconds from ${model.minSeconds} to 15.`);
  }
  const lines = [{ label: `${duration}s ${model.label} at ${resolution}`, cost: duration * rate }];

  const images = refs.filter((r) => r.type === 'image').length;
  if (images > model.freeImages) {
    const extra = images - model.freeImages;
    lines.push({ label: `${extra} image(s) beyond the ${model.freeImages} free`, cost: extra * model.extraImage });
  }
  for (const v of refs.filter((r) => r.type === 'video')) {
    lines.push({ label: `reference video (${Number(v.seconds)}s)`, cost: Number(v.seconds) * model.refVideoRates[resolution] });
  }
  const rounded = lines.map((l) => ({ ...l, cost: round(l.cost) }));
  return { lines: rounded, total: round(rounded.reduce((s, l) => s + l.cost, 0)), mode, ratio };
}

function upgradeEstimate(job) {
  // Jobs saved before the model field existed were all plain H3.
  if (job.type === 'upgrade' || (job.model ?? 'MiniMax-H3') !== 'MiniMax-H3' || job.resolution !== '768P') return null;
  if (job.status !== 'succeeded' || job.upgradedTo) return null;
  if (Date.now() - new Date(job.createdAt).getTime() > UPGRADE_WINDOW_DAYS * 86400000) return null;
  const lines = [
    { label: `${job.duration}s regenerated at 2K`, cost: job.duration * UPGRADE.outputRate },
    { label: `source video as input (${job.duration}s)`, cost: job.duration * UPGRADE.inputVideoRate },
  ];
  const images = (job.refs || []).filter((r) => r.type === 'image').length;
  if (images > UPGRADE.freeImages) lines.push({ label: `${images - UPGRADE.freeImages} extra image(s)`, cost: (images - UPGRADE.freeImages) * UPGRADE.extraImage });
  const rounded = lines.map((l) => ({ ...l, cost: round(l.cost) }));
  return { lines: rounded, total: round(rounded.reduce((s, l) => s + l.cost, 0)) };
}

function buildContent({ prompt, refs = [] }) {
  const content = [{ type: 'text', text: prompt }];
  for (const r of refs) {
    if (r.type === 'image') content.push({ type: 'image_url', image_url: { url: r.url }, role: r.role });
    else if (r.type === 'video') content.push({ type: 'video_url', video_url: { url: r.url }, role: 'reference_video' });
    else if (r.type === 'audio') content.push({ type: 'audio_url', audio_url: { url: r.url }, role: 'reference_audio' });
  }
  return content;
}

// Share links (Drive, Dropbox) point at a web page, not the file. Rewrite them to direct downloads.
function directUrl(url) {
  const drive = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || url.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download`;
  if (/(^|\.)dropbox\.com$/.test(new URL(url).host)) {
    const u = new URL(url);
    u.searchParams.set('dl', '1');
    u.searchParams.delete('raw');
    return u.toString();
  }
  return url;
}

// Confirm each link returns the right kind of file BEFORE anything is charged.
// This checks from your machine, so a host that blocks MiniMax's servers can still fail later.
async function prepareRefs(refs = []) {
  const prefix = { image: 'image/', video: 'video/', audio: 'audio/' };
  const out = [];
  for (const r of refs) {
    if (!/^https?:\/\//i.test(r.url)) { out.push(r); continue; } // inline data: URLs can't be checked
    const url = directUrl(r.url);
    let res;
    try {
      res = await fetch(url, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new Error(`Couldn't reach ${r.url} (${e.message}). The link must be public.`);
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    await res.body?.cancel();
    if (!res.ok) throw new Error(`${r.url} returned HTTP ${res.status}. Make sure it is shared with "Anyone with the link".`);
    if (!type.startsWith(prefix[r.type])) {
      throw new Error(`${r.url} returned "${type || 'unknown'}" instead of ${r.type} data. It is probably a web page, not a direct file link.`);
    }
    out.push({ ...r, url });
  }
  return out;
}

// ---- http helpers ----------------------------------------------------------------------------

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 80 * MB) throw new Error('Request too large.');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function mm(pathname, init = {}) {
  const r = await fetch(BASE_URL + pathname, {
    ...init,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

// MiniMax errors look like { type:'error', error:{ type, message, http_code }, request_id }.
function mmError(r) {
  const e = r.json?.error;
  if (e?.message) return `${e.message}${e.type ? ` [${e.type}]` : ''}`;
  return r.json?.base_resp?.status_msg || `HTTP ${r.status}`;
}

// ---- routes ------------------------------------------------------------------------------------


// ---- ffmpeg: last frame + stitching --------------------------------------------------------

const jobFile = (job) => path.join(OUT_DIR, path.basename(job.file));

async function lastFrame(job) {
  const out = path.join(FRAMES_DIR, `${path.basename(job.file, '.mp4')}.png`);
  await run('ffmpeg', ['-y', '-v', 'error', '-sseof', '-0.2', '-i', jobFile(job), '-frames:v', '1', '-update', '1', out]);
  return path.basename(out);
}

async function hasAudio(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return stdout.trim().length > 0;
}

// Re-encodes every clip to the first clip's size so mixed resolutions still join cleanly.
async function stitch(jobs) {
  const files = jobs.map(jobFile);
  for (let i = 0; i < files.length; i++) {
    if (!(await hasAudio(files[i]))) throw new Error(`Clip ${i + 1} has no audio track, so it can't be joined.`);
  }
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', files[0]]);
  const [w, h] = probe.stdout.trim().split('x').map(Number);
  const prep = files.map((_, i) =>
    `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}];` +
    `[${i}:a]aresample=32000,aformat=channel_layouts=stereo[a${i}]`).join(';');
  const filter = `${prep};${files.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${files.length}:v=1:a=1[v][a]`;
  const name = `stitch-${Date.now()}.mp4`;
  await run('ffmpeg', [
    '-y', '-v', 'error', ...files.flatMap((f) => ['-i', f]),
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(OUT_DIR, name),
  ], { maxBuffer: 16 * MB });
  return name;
}

// ---- remembering references ----------------------------------------------------------------------

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav' };

// Web links are kept as they are. Uploaded files (data: URLs) are saved once to data/refs, so a job or
// library entry only has to remember the file name and reuse can load the same file again.
async function persistRefs(refs = []) {
  const out = [];
  for (const r of refs) {
    const base = { type: r.type, role: r.role, name: r.name, seconds: r.seconds, character: r.character };
    const m = typeof r.url === 'string' ? r.url.match(/^data:([^;,]+);base64,(.*)$/s) : null;
    if (!m) { out.push({ ...base, url: r.url }); continue; }
    const ext = EXT[m[1]];
    if (!ext) { out.push(base); continue; } // a file type we can't store, so there's nothing to remember
    const bytes = Buffer.from(m[2], 'base64');
    const file = `${createHash('sha1').update(bytes).digest('hex')}.${ext}`;
    await fs.writeFile(path.join(REFS_DIR, file), bytes).catch(() => {});
    out.push({ ...base, file });
  }
  return out;
}

// ---- library (saved prompts and reference sets) ------------------------------------------------

async function readLibrary() {
  try {
    return JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
  } catch {
    return { items: [] };
  }
}

// ---- reconciling with MiniMax's List Tasks (read-only) ------------------------------------

// What MiniMax says it metered for a finished task, priced with the same rates the estimate uses.
function meteredCost(item) {
  const u = item.usage;
  const model = MODELS[item.model];
  if (!u || !model) return null;
  if (item.task_type === 'regeneration') {
    const extra = Math.max(0, (u.input_image_count || 0) - UPGRADE.freeImages) * UPGRADE.extraImage;
    return round((u.output_seconds || 0) * UPGRADE.outputRate + (u.input_seconds || 0) * UPGRADE.inputVideoRate + extra);
  }
  const rate = model.rates[item.resolution];
  if (!rate) return null;
  let cost = (u.output_seconds ?? item.duration ?? 0) * rate;
  cost += Math.max(0, (u.input_image_count || 0) - model.freeImages) * model.extraImage;
  cost += (u.input_seconds || 0) * (model.refVideoRates[item.resolution] ?? rate);
  return round(cost);
}

async function listAllTasks() {
  const items = [];
  for (let page = 1; page <= 30; page++) {
    const r = await mm(`/v2/query/video_generation?page_num=${page}&page_size=50`);
    if (!r.ok) throw new Error(`MiniMax: ${mmError(r)}`);
    const batch = r.json.items || [];
    items.push(...batch);
    if (!batch.length || items.length >= (r.json.total ?? 0)) break;
  }
  return items;
}

async function saveVideo(job, url) {
  const dl = await fetch(url);
  if (!dl.ok) return false;
  job.file = `${job.id}.mp4`;
  await fs.writeFile(path.join(OUT_DIR, job.file), Buffer.from(await dl.arrayBuffer()));
  return true;
}

const routes = {
  'GET /api/status': async () => {
    const l = await readLedger();
    return [200, {
      maxSpend: MAX_SPEND,
      spent: round(totalSpent(l)),
      remaining: remainingOf(l),
      syncedAt: l.balanceSync?.at ?? null,
      syncedAmount: l.balanceSync?.amount ?? null,
      models: MODELS,
      ratios: RATIOS,
      expansion: EXPANSION,
      limits: LIMITS,
      lowBalance: LOW_BALANCE,
      maxDaily: MAX_DAILY,
      spentToday: round(spentToday(l)),
    }];
  },

  // Set your real balance from the MiniMax billing page; later spending is subtracted from it.
  'POST /api/balance': async (req) => {
    const { balance } = await readBody(req);
    const amount = Number(balance);
    if (!Number.isFinite(amount) || amount < 0) return [400, { error: 'Enter a balance like 23.47.' }];
    const l = await readLedger();
    l.balanceSync = { amount: round(amount), at: new Date().toISOString() };
    await writeLedger(l);
    return [200, { remaining: remainingOf(l), syncedAt: l.balanceSync.at }];
  },

  'POST /api/estimate': async (req) => [200, estimate(await readBody(req))],

  'POST /api/generate': async (req) => {
    const body = await readBody(req);
    if (!body.prompt?.trim()) return [400, { error: 'Prompt is required.' }];
    const est = estimate(body); // validates the whole request
    // The UI must echo back the price the user was shown.
    if (round(body.confirmedTotal) !== est.total) {
      return [409, { error: `Price changed to $${est.total.toFixed(2)}. Review and confirm again.`, estimate: est }];
    }
    const l = await readLedger();
    if (est.total > remainingOf(l)) {
      return [402, { error: `Would exceed your remaining balance ($${remainingOf(l).toFixed(2)}).` }];
    }
    if (MAX_DAILY && spentToday(l) + est.total > MAX_DAILY) {
      return [402, { error: `Would exceed your daily limit of $${MAX_DAILY} ($${round(MAX_DAILY - spentToday(l))} left today).` }];
    }

    let refs;
    try {
      refs = await prepareRefs(body.refs);
    } catch (e) {
      return [400, { error: e.message }];
    }

    const payload = {
      model: body.model || 'MiniMax-H3',
      content: buildContent({ prompt: body.prompt, refs }),
      duration: body.duration,
      resolution: body.resolution,
      ratio: est.ratio,
    };
    // 'balanced' is MiniMax's default, so only send the field when it changes something.
    if (EXPANSION.includes(body.expansion) && body.expansion !== 'balanced') {
      payload.extra = { prompt_expansion_mode: body.expansion };
    }

    const r = await mm('/v2/video_generation', { method: 'POST', body: JSON.stringify(payload) });
    const taskId = r.json.task_id;
    if (!r.ok || !taskId) {
      // Nothing was created, so nothing is recorded. No automatic retry.
      return [r.status === 402 ? 402 : 502, { error: `MiniMax: ${mmError(r)}`, detail: r.json }];
    }
    l.jobs.push({
      id: taskId, type: 'generation', model: payload.model, mode: est.mode,
      prompt: body.prompt, cost: est.total, resolution: body.resolution, duration: body.duration,
      ratio: est.ratio, expansion: body.expansion || 'balanced',
      castBlock: String(body.castBlock || '').slice(0, 3000), // the auto-written character lines at the start of `prompt`
      status: 'processing', file: null, createdAt: new Date().toISOString(),
      // What was actually sent, so the history can show whether references went out.
      refs: await persistRefs(refs),
    });
    await writeLedger(l);
    return [200, { taskId, estimate: est }];
  },

  // 768P -> 2K regeneration of a finished H3 job (only valid for jobs from the last 7 days).
  'POST /api/upgrade': async (req) => {
    const { taskId, confirmedTotal } = await readBody(req);
    const l = await readLedger();
    const job = l.jobs.find((j) => j.id === taskId);
    const est = job && upgradeEstimate(job);
    if (!est) return [400, { error: 'That job cannot be upgraded (it must be a finished H3 768P job from the last 7 days that has not been upgraded).' }];
    if (round(confirmedTotal) !== est.total) return [409, { error: `Price changed to $${est.total.toFixed(2)}. Review and confirm again.` }];
    if (est.total > remainingOf(l)) return [402, { error: `Would exceed your remaining balance ($${remainingOf(l).toFixed(2)}).` }];

    const r = await mm('/v2/video_regeneration', {
      method: 'POST',
      body: JSON.stringify({ model: 'MiniMax-H3', source_task_id: taskId, resolution: '2K' }),
    });
    if (!r.ok || !r.json.task_id) return [r.status === 402 ? 402 : 502, { error: `MiniMax: ${mmError(r)}`, detail: r.json }];
    job.upgradedTo = r.json.task_id;
    l.jobs.push({
      id: r.json.task_id, type: 'upgrade', sourceTaskId: taskId, model: 'MiniMax-H3', mode: job.mode,
      prompt: job.prompt, cost: est.total, resolution: '2K', duration: job.duration, ratio: job.ratio,
      status: 'processing', file: null, createdAt: new Date().toISOString(), refs: job.refs || [],
    });
    await writeLedger(l);
    return [200, { taskId: r.json.task_id, estimate: est }];
  },

  // Join finished clips, in the order given, into one video. Costs nothing and never counts toward spend.
  'POST /api/stitch': async (req) => {
    const { ids } = await readBody(req);
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 10) return [400, { error: 'Pick 2 to 10 clips to stitch.' }];
    const l = await readLedger();
    const jobs = ids.map((id) => l.jobs.find((j) => j.id === id));
    if (jobs.some((j) => !j?.file)) return [400, { error: 'Every selected clip needs a downloaded video.' }];
    let name;
    try {
      name = await stitch(jobs);
    } catch (e) {
      return [500, { error: `Stitching failed: ${e.stderr?.toString().split('\n').filter(Boolean).pop() || e.message}` }];
    }
    const total = jobs.reduce((t, j) => t + j.duration, 0);
    l.jobs.push({
      id: name.replace('.mp4', ''), type: 'stitch', model: 'local', prompt: `Stitched ${jobs.length} clips (~${total}s)`,
      cost: 0, resolution: jobs[0].resolution, duration: total, ratio: jobs[0].ratio, status: 'succeeded',
      file: name, createdAt: new Date().toISOString(), refs: [], sources: ids,
    });
    await writeLedger(l);
    return [200, { file: name }];
  },

  // Compare the ledger with MiniMax's own record of the last 7 days. Read-only: nothing is billed.
  'POST /api/reconcile': async () => {
    let items;
    try {
      items = await listAllTasks();
    } catch (e) {
      return [502, { error: e.message }];
    }
    const l = await readLedger();
    const byId = new Map(items.map((i) => [String(i.id), i]));
    const report = { checked: items.length, matched: 0, notInLedger: [], mismatches: [], failedUnmetered: [], updated: 0 };

    for (const item of items) {
      const job = l.jobs.find((j) => j.id === String(item.id));
      const metered = meteredCost(item);
      if (!job) {
        report.notInLedger.push({
          id: String(item.id), model: item.model, status: item.status, duration: item.duration,
          resolution: item.resolution, createdAt: new Date(item.created_at * 1000).toISOString(), meteredCost: metered,
        });
        continue;
      }
      report.matched++;
      const status = normalizeStatus(item.status);
      if (job.status !== status) { job.status = status; report.updated++; }
      job.rawStatus = item.status;
      if (item.usage) job.usage = item.usage;
      if (metered != null) job.meteredCost = metered;
      if (status === 'failed') job.failReason = item.error?.message ?? job.failReason ?? null;
      if (status === 'succeeded' && !job.file && item.content?.url) await saveVideo(job, item.content.url);
      if (metered != null && !job.refunded && Math.abs(job.cost - metered) > 0.005) {
        report.mismatches.push({ id: job.id, ledger: job.cost, metered });
      }
    }
    // Failed jobs in the last 7 days that MiniMax reports no usage for: probably not charged, but verify on the billing page.
    const weekAgo = Date.now() - 7 * 86400000;
    for (const job of l.jobs) {
      if (job.status === 'failed' && !job.refunded && job.cost > 0 && new Date(job.createdAt).getTime() > weekAgo) {
        const item = byId.get(job.id);
        if (item && !item.usage) report.failedUnmetered.push({ id: job.id, cost: job.cost, reason: job.failReason || null });
      }
    }
    await writeLedger(l);
    return [200, report];
  },

  // Mark several jobs as not charged in one go (used after reviewing a reconcile report).
  'POST /api/refund-many': async (req) => {
    const { ids } = await readBody(req);
    const l = await readLedger();
    let n = 0;
    for (const j of l.jobs) if (Array.isArray(ids) && ids.includes(j.id)) { j.refunded = true; n++; }
    await writeLedger(l);
    return [200, { changed: n, remaining: remainingOf(l) }];
  },

  'GET /api/stats': async () => {
    const l = await readLedger();
    const billed = l.jobs.filter((j) => isBilled(j) && j.type !== 'stitch'); // stitches are free local joins
    const byDay = new Map();
    const byModel = new Map();
    for (const j of billed) {
      const d = byDay.get(localDay(j.createdAt)) || { spent: 0, jobs: 0 };
      d.spent += j.cost; d.jobs++;
      byDay.set(localDay(j.createdAt), d);
      const m = byModel.get(j.model || 'MiniMax-H3') || { spent: 0, jobs: 0, seconds: 0 };
      m.spent += j.cost; m.jobs++; m.seconds += j.duration;
      byModel.set(j.model || 'MiniMax-H3', m);
    }
    const failed = billed.filter((j) => j.status === 'failed');
    const seconds = billed.filter((j) => j.cost > 0).reduce((t, j) => t + j.duration, 0);
    return [200, {
      byDay: [...byDay].sort().slice(-14).map(([day, v]) => ({ day, spent: round(v.spent), jobs: v.jobs })),
      byModel: [...byModel].map(([model, v]) => ({ model, spent: round(v.spent), jobs: v.jobs, seconds: v.seconds })),
      totals: {
        jobs: billed.length, spent: round(totalSpent(l)), failed: failed.length,
        failedCost: round(failed.reduce((t, j) => t + j.cost, 0)),
        avgPerSecond: seconds ? round((totalSpent(l) / seconds) * 1000) / 1000 : 0,
      },
    }];
  },

  'GET /api/library': async () => [200, await readLibrary()],

  'POST /api/library': async (req) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return [400, { error: 'Give it a name.' }];
    let item;
    if (body.kind === 'prompt') {
      if (!String(body.prompt || '').trim()) return [400, { error: 'The prompt is empty.' }];
      item = { kind: 'prompt', prompt: String(body.prompt), refs: Array.isArray(body.refs) ? await persistRefs(body.refs) : [] };
    } else if (body.kind === 'refset') {
      if (!Array.isArray(body.refs) || !body.refs.length) return [400, { error: 'No references to save.' }];
      item = { kind: 'refset', refs: await persistRefs(body.refs) };
    } else {
      return [400, { error: 'Unknown library item.' }];
    }
    const lib = await readLibrary();
    lib.items.push({ id: randomUUID(), name, createdAt: new Date().toISOString(), ...item });
    if (JSON.stringify(lib).length > 10 * MB) return [413, { error: 'The library is full (10 MB). Delete something first, or save URLs instead of uploaded files.' }];
    await fs.writeFile(LIBRARY, JSON.stringify(lib, null, 2));
    return [200, lib];
  },

  'GET /api/history': async () => {
    const l = await readLedger();
    const jobs = [...l.jobs].reverse().map((j) => ({ ...j, upgrade: upgradeEstimate(j) }));
    return [200, { jobs }];
  },
};

// The finished-task shape for failures isn't documented, so keep whatever MiniMax sends.
function failReason(t) {
  return t.fail_reason ?? t.error?.message ?? t.error_message ?? t.status_msg ?? t.message ?? null;
}

async function getTask(taskId) {
  const r = await mm(`/v2/query/video_generation/${encodeURIComponent(taskId)}`);
  if (!r.ok) return [502, { error: `Status check failed: ${mmError(r)}`, detail: r.json }];
  // MiniMax wraps the task: { task: { status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', ... } }
  const t = r.json.task ?? r.json;
  const status = normalizeStatus(t.status);
  const l = await readLedger();
  const job = l.jobs.find((j) => j.id === taskId);
  if (job) {
    job.status = status;
    job.rawStatus = t.status;
    if (t.usage) job.usage = t.usage; // what MiniMax says it metered
    const url = t.content?.url ?? findVideoUrl(t);
    if (status === 'succeeded' && url && !job.file) {
      const dl = await fetch(url);
      if (!dl.ok) return [502, { error: 'Video finished but the download failed. Retry status check.' }];
      job.file = `${taskId}.mp4`;
      await fs.writeFile(path.join(OUT_DIR, job.file), Buffer.from(await dl.arrayBuffer()));
    }
    if (status === 'failed') {
      job.failReason = failReason(t);
      const { content, ...rest } = t;
      job.raw = JSON.stringify(rest).slice(0, 1500);
    }
    await writeLedger(l);
  }
  const finishedWithoutUrl = status === 'succeeded' && !job?.file;
  return [200, {
    status,
    videoUrl: job?.file ? `/videos/${job.file}` : null,
    detail: status === 'failed' || finishedWithoutUrl ? r.json : undefined,
  }];
}

// Anything not clearly finished stays 'processing' so the UI keeps polling.
function normalizeStatus(s) {
  const v = String(s ?? '').toLowerCase();
  if (['succeeded', 'success', 'completed', 'done', 'finished'].includes(v)) return 'succeeded';
  if (['failed', 'error'].includes(v)) return 'failed';
  if (['cancelled', 'canceled'].includes(v)) return 'cancelled';
  return 'processing';
}

// Look for a video URL anywhere in the reply, in case the documented location changes.
function findVideoUrl(obj) {
  if (typeof obj === 'string') return /^https?:\/\//.test(obj) ? obj : null;
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const found = findVideoUrl(v);
      if (found) return found;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    if (routes[key]) {
      const [status, body] = await routes[key](req);
      return send(res, status, body);
    }
    // Mark a job as not charged (or charged again), e.g. a failed job MiniMax didn't bill for.
    const refund = url.pathname.match(/^\/api\/jobs\/([^/]+)\/refunded$/);
    if (req.method === 'POST' && refund) {
      const { refunded } = await readBody(req);
      const l = await readLedger();
      const job = l.jobs.find((j) => j.id === refund[1]);
      if (!job) return send(res, 404, { error: 'Job not found.' });
      job.refunded = !!refunded;
      await writeLedger(l);
      return send(res, 200, { remaining: remainingOf(l) });
    }
    // Per-job actions.
    const action = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(cancel|hide|delete-file|last-frame)$/);
    if (req.method === 'POST' && action) {
      const [, id, what] = action;
      const l = await readLedger();
      const job = l.jobs.find((j) => j.id === id);
      if (!job) return send(res, 404, { error: 'Job not found.' });

      if (what === 'hide') {
        const { hidden } = await readBody(req);
        job.hidden = !!hidden; // never delete the row: it backs the spend math
        await writeLedger(l);
        return send(res, 200, { ok: true });
      }
      if (what === 'delete-file') {
        if (!job.file) return send(res, 400, { error: 'No local file.' });
        await fs.rm(jobFile(job), { force: true });
        job.file = null;
        job.fileDeleted = true;
        await writeLedger(l);
        return send(res, 200, { ok: true });
      }
      if (what === 'last-frame') {
        if (!job.file) return send(res, 400, { error: 'This job has no downloaded video.' });
        try {
          return send(res, 200, { url: `/frames/${await lastFrame(job)}` });
        } catch (e) {
          return send(res, 500, { error: `Couldn't extract a frame: ${e.stderr?.toString().trim() || e.message}` });
        }
      }
      // cancel: MiniMax only allows this for queued tasks, and says there is no charge.
      const r = await mm(`/v2/video_generation/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      if (!r.ok) return send(res, r.status === 400 ? 409 : 502, { error: `MiniMax: ${mmError(r)}`, detail: r.json });
      job.status = 'cancelled';
      job.refunded = true;
      await writeLedger(l);
      return send(res, 200, { remaining: remainingOf(l) });
    }
    const libDel = url.pathname.match(/^\/api\/library\/([^/]+)$/);
    if (req.method === 'DELETE' && libDel) {
      const lib = await readLibrary();
      lib.items = lib.items.filter((i) => i.id !== libDel[1]);
      await fs.writeFile(LIBRARY, JSON.stringify(lib, null, 2));
      return send(res, 200, lib);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/refs/')) {
      const file = path.basename(url.pathname);
      const data = await fs.readFile(path.join(REFS_DIR, file)).catch(() => null);
      if (!data) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'Content-Length': data.length });
      return res.end(data);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/frames/')) {
      const data = await fs.readFile(path.join(FRAMES_DIR, path.basename(url.pathname))).catch(() => null);
      if (!data) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length });
      return res.end(data);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const [status, body] = await getTask(url.pathname.slice('/api/tasks/'.length));
      return send(res, status, body);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/videos/')) {
      const file = path.basename(url.pathname);
      const data = await fs.readFile(path.join(OUT_DIR, file)).catch(() => null);
      if (!data) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
      return res.end(data);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// Loopback only: nothing else on your network can reach it.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kinowrap server on http://127.0.0.1:${PORT}  (cap $${MAX_SPEND})`);
});
