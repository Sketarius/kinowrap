import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

type RefType = 'image' | 'video' | 'audio';
type Role = 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
type Mode = 't2v' | 'i2v' | 'r2v' | 'mixed';

interface Ref {
  type: RefType;
  role: Role;
  url: string;
  name: string;
  seconds?: number;
  character?: string; // who this reference belongs to (used to write the cast lines)
}
interface ModelInfo { label: string; minSeconds: number; rates: Record<string, number>; maxSeconds?: number; maxSecondsByRes?: Record<string, number>; ratios?: string[]; local?: boolean; canUpscale?: boolean; upscalers?: { id: string; label: string; perSecond: number; note: string }[] }
interface Limits {
  prompt: number; referenceImages: number; videos: number; audios: number; totalFiles: number;
  clipMin: number; clipMax: number; videoTotalSeconds: number; audioTotalSeconds: number;
  imageBytes: number; videoBytes: number; audioBytes: number; requestBytes: number;
}
interface Line { label: string; cost: number }
interface Estimate { lines: Line[]; total: number; mode: string; ratio: string; localEta?: { seconds: number; duration: number; mode: string; resolution: string } | null }
interface Status {
  maxSpend: number; spent: number; remaining: number; syncedAt: string | null; syncedAmount: number | null;
  models: Record<string, ModelInfo>; ratios: string[]; expansion: string[]; limits: Limits;
  lowBalance: number; maxDaily: number; spentToday: number;
}
interface Job {
  id: string; prompt: string; cost: number; resolution: string; duration: number;
  status: string; file: string | null; createdAt: string;
  type?: string; model?: string; ratio?: string; expansion?: string;
  refs?: StoredRef[]; refunded?: boolean;
  usage?: { output_seconds?: number; input_seconds?: number; total_seconds?: number; input_image_count?: number };
  failReason?: string | null; raw?: string; upgrade?: { lines: Line[]; total: number } | null; upgradedTo?: string;
  hidden?: boolean; fileDeleted?: boolean; rawStatus?: string; progress?: { step: number; total: number; elapsed: number; eta: number; phase?: string }; upscaledTo?: string; sourceId?: string; upscaler?: string; startedAt?: string; meteredCost?: number; sources?: string[]; castBlock?: string;
}
// A reference as the server remembers it: a web link, or the name of an uploaded file it saved.
interface StoredRef { type: RefType; role: Role; url?: string; file?: string; name?: string; seconds?: number; character?: string }
interface LibraryItem { id: string; kind: 'prompt' | 'refset'; name: string; prompt?: string; refs?: StoredRef[] }
interface Stats {
  byDay: { day: string; spent: number; jobs: number }[];
  byModel: { model: string; spent: number; jobs: number; seconds: number }[];
  totals: { jobs: number; spent: number; failed: number; failedCost: number; avgPerSecond: number };
}
interface Report {
  checked: number; matched: number; updated: number;
  notInLedger: { id: string; model: string; status: string; duration: number; resolution: string; createdAt: string; meteredCost: number | null }[];
  mismatches: { id: string; ledger: number; metered: number }[];
  failedUnmetered: { id: string; cost: number; reason: string | null }[];
}

const DRAFT_KEY = 'kinowrap.draft.v1';
const OLD_DRAFT_KEY = 'h3studio.draft.v1'; // read once so a draft saved before the rename isn't lost

const MODE_LABEL: Record<Mode, string> = {
  t2v: 'Text-to-video',
  i2v: 'Image-to-video (first/last frame)',
  r2v: 'Reference-to-video',
  mixed: 'Invalid mix',
};

@Component({
  selector: 'app-root',
  imports: [DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private http = inject(HttpClient);

  model = signal('MiniMax-H3');
  prompt = signal('');
  // Which AI upscaler the "Upscale to 768p" buttons use (local clips only); remembered between visits.
  upscaler = signal<string>((() => { try { return localStorage.getItem('kinowrap.upscaler') ?? ''; } catch { return ''; } })());
  upscalers = computed(() => this.models()['local-h3']?.upscalers ?? []);
  chosenUpscaler = computed(() => (this.upscalers().some((u) => u.id === this.upscaler()) ? this.upscaler() : this.upscalers()[0]?.id ?? ''));
  duration = signal(6);
  resolution = signal('768P');
  ratio = signal('9:16');
  expansion = signal('balanced');
  refs = signal<Ref[]>([]);
  useCast = signal(true);

  estimate = signal<Estimate | null>(null);
  status = signal<Status | null>(null);
  jobs = signal<Job[]>([]);
  error = signal('');
  busy = signal(false);

  // ---- history view, library, insights ---------------------------------------------------------
  search = signal('');
  statusFilter = signal('all');
  modelFilter = signal('all');
  showHidden = signal(false);
  visibleCount = signal(10);
  selected = signal<string[]>([]);
  library = signal<LibraryItem[]>([]);
  stats = signal<Stats | null>(null);
  report = signal<Report | null>(null);
  reconciling = signal(false);
  stitching = signal(false);

  filteredJobs = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.jobs().filter(
      (j) =>
        (this.showHidden() || !j.hidden) &&
        (this.statusFilter() === 'all' || j.status === this.statusFilter()) &&
        (this.modelFilter() === 'all' || (j.model ?? 'MiniMax-H3') === this.modelFilter()) &&
        (!q || j.prompt.toLowerCase().includes(q)),
    );
  });
  visibleJobs = computed(() => this.filteredJobs().slice(0, this.visibleCount()));
  hiddenCount = computed(() => this.jobs().filter((j) => j.hidden).length);
  dayMax = computed(() => Math.max(0.01, ...(this.stats()?.byDay.map((d) => d.spent) ?? [0])));
  lowBalance = computed(() => {
    const s = this.status();
    return !!s && s.remaining < s.lowBalance;
  });

  // ---- values derived from the server's rules --------------------------------------------------
  models = computed(() => this.status()?.models ?? {});
  modelKeys = computed(() => Object.keys(this.models()));
  modelInfo = computed(() => this.models()[this.model()]);
  resolutions = computed(() => Object.keys(this.modelInfo()?.rates ?? {}));
  minSeconds = computed(() => this.modelInfo()?.minSeconds ?? 4);
  maxSeconds = computed(() => this.modelInfo()?.maxSecondsByRes?.[this.resolution()] ?? this.modelInfo()?.maxSeconds ?? 15);
  isLocal = computed(() => !!this.modelInfo()?.local);
  limits = computed(() => this.status()?.limits);

  mode = computed<Mode>(() => {
    const r = this.refs();
    const frame = r.some((x) => x.role === 'first_frame' || x.role === 'last_frame');
    const media = r.some((x) => x.role.startsWith('reference'));
    return frame && media ? 'mixed' : frame ? 'i2v' : media ? 'r2v' : 't2v';
  });
  modeLabel = computed(() => MODE_LABEL[this.mode()]);

  // MiniMax: text-to-video needs a concrete ratio; image-to-video is always adaptive; reference-to-video allows both.
  ratioOptions = computed(() => {
    const ratios = this.modelInfo()?.ratios ?? this.status()?.ratios ?? [];
    return this.mode() === 'i2v' ? ['adaptive'] : this.mode() === 'r2v' ? ['adaptive', ...ratios] : ratios;
  });
  effectiveRatio = computed(() => {
    if (this.mode() === 'i2v') return 'adaptive';
    if (this.mode() === 't2v' && this.ratio() === 'adaptive') return '16:9';
    return this.ratio();
  });

  problems = computed(() => {
    const p: string[] = [];
    const lim = this.limits();
    if (!lim) return p;
    const refs = this.refs();
    const count = (role: Role) => refs.filter((r) => r.role === role).length;
    if (this.mode() === 'mixed') p.push("First/last frame images can't be combined with reference images, video or audio.");
    if (count('first_frame') > 1) p.push('Only one first frame is allowed.');
    if (count('last_frame') > 1) p.push('Only one last frame is allowed.');
    if (count('reference_image') > lim.referenceImages) p.push(`At most ${lim.referenceImages} reference images.`);
    if (count('reference_video') > lim.videos) p.push(`At most ${lim.videos} reference videos.`);
    if (count('reference_audio') > lim.audios) p.push(`At most ${lim.audios} reference audio clips.`);
    const media = refs.filter((r) => r.role.startsWith('reference')).length;
    if (media > lim.totalFiles) p.push(`At most ${lim.totalFiles} reference files in total.`);
    const videos = refs.filter((r) => r.type === 'video');
    const audios = refs.filter((r) => r.type === 'audio');
    if (videos.some((v) => !(v.seconds! >= lim.clipMin && v.seconds! <= lim.clipMax))) {
      p.push(`Each reference video needs a length of ${lim.clipMin}-${lim.clipMax} seconds.`);
    }
    if (videos.reduce((t, v) => t + (v.seconds ?? 0), 0) > lim.videoTotalSeconds) p.push(`Reference videos can total at most ${lim.videoTotalSeconds} seconds.`);
    if (audios.some((a) => a.seconds != null && !(a.seconds >= lim.clipMin && a.seconds <= lim.clipMax))) {
      p.push(`Each reference audio clip must be ${lim.clipMin}-${lim.clipMax} seconds.`);
    }
    if (audios.length && audios.every((a) => a.seconds) && audios.reduce((t, a) => t + a.seconds!, 0) > lim.audioTotalSeconds) {
      p.push(`Reference audio can total at most ${lim.audioTotalSeconds} seconds.`);
    }
    if (this.effectivePrompt().length > lim.prompt) p.push(`Prompt is over the ${lim.prompt}-character limit${this.castBlock() ? ' (the cast lines count too)' : ''}.`);
    return p;
  });

  // ---- cast: which reference belongs to which character --------------------------------------------
  // MiniMax counts references by type, in list order ("Image 2", "Audio 1"), and only the prompt can say who is who.

  numbers = computed(() => {
    const seen = { image: 0, video: 0, audio: 0 };
    return this.refs().map((r) => {
      if (!r.role.startsWith('reference')) return null;
      const n = ++seen[r.type];
      return { kind: r.type, n, label: `${r.type === 'image' ? 'Image' : r.type === 'video' ? 'Video' : 'Audio'} ${n}` };
    });
  });

  characterNames = computed(() => [...new Set(this.refs().map((r) => r.character?.trim()).filter((c): c is string => !!c))]);

  castBlock = computed(() => {
    if (!this.useCast()) return '';
    const nums = this.numbers();
    const groups = new Map<string, { image: number[]; video: number[]; audio: number[] }>();
    this.refs().forEach((r, i) => {
      const name = r.character?.trim();
      const num = nums[i];
      if (!name || !num) return;
      if (!groups.has(name)) groups.set(name, { image: [], video: [], audio: [] });
      groups.get(name)![num.kind].push(num.n);
    });
    const list = (label: string, ns: number[]) =>
      ns.length === 1 ? `${label} ${ns[0]}` : `${label}s ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
    const lines: string[] = [];
    let voices = 0;
    for (const [name, g] of groups) {
      if (g.image.length) lines.push(`${list('Image', g.image)} ${g.image.length > 1 ? 'show' : 'shows'} ${name}.`);
      if (g.video.length) lines.push(`${list('Video', g.video)} ${g.video.length > 1 ? 'are' : 'is'} ${name}'s motion reference.`);
      if (g.audio.length) {
        voices += g.audio.length;
        lines.push(`${list('Audio', g.audio)} ${g.audio.length > 1 ? 'are' : 'is'} ${name}'s voice: use it only when ${name} speaks, never for anyone else.`);
      }
    }
    if (voices > 1) lines.push('Each voice belongs only to the character it is assigned to.');
    return lines.join('\n');
  });

  effectivePrompt = computed(() => (this.castBlock() ? `${this.castBlock()}\n\n${this.prompt()}` : this.prompt()));

  // Advice only (nothing here blocks generating).
  castNotes = computed(() => {
    const notes: string[] = [];
    const refs = this.refs();
    const nums = this.numbers();
    refs.forEach((r, i) => {
      if (r.type === 'audio' && !r.character?.trim() && nums[i]) {
        notes.push(`${nums[i]!.label} has no character, so nothing ties that voice to a face. Give it the same name as its image.`);
      }
    });
    // Once any character is named, an unnamed image or video is left out of the cast lines entirely.
    if (this.characterNames().length) {
      refs.forEach((r, i) => {
        if (r.type !== 'audio' && !r.character?.trim() && nums[i]) {
          notes.push(`${nums[i]!.label} (${this.displayName(r)}) has no label, so the cast lines skip it. Name it (for a place, something like "Old Castle") so the prompt can point to it.`);
        }
      });
    }
    for (const name of this.characterNames()) {
      const mine = refs.filter((r) => r.character?.trim() === name);
      if (mine.some((r) => r.type === 'audio') && !mine.some((r) => r.type === 'image' || r.type === 'video')) {
        notes.push(`${name} has a voice but no image.`);
      }
    }
    if (refs.some((r) => r.type === 'audio') && !refs.some((r) => r.type === 'image' || r.type === 'video')) {
      notes.push('Reference audio usually needs at least one image or video with it, or MiniMax may reject it.');
    }
    return notes;
  });

  setCharacter(i: number, value: string) {
    this.refs.update((r) => r.map((x, idx) => (idx === i ? { ...x, character: value } : x)));
  }

  // Moves a reference up or down among references of the same kind, since numbering is per kind.
  moveRef(i: number, dir: -1 | 1) {
    const refs = [...this.refs()];
    let j = i + dir;
    while (j >= 0 && j < refs.length && refs[j].type !== refs[i].type) j += dir;
    if (j < 0 || j >= refs.length) return;
    [refs[i], refs[j]] = [refs[j], refs[i]];
    this.refs.set(refs);
  }

  canGenerate = computed(() => {
    const e = this.estimate();
    const s = this.status();
    return !!this.prompt().trim() && !!e && !!s && !this.problems().length && e.total <= s.remaining && !this.busy();
  });

  private timer?: ReturnType<typeof setInterval>;
  private lastStatus = new Map<string, string>();

  constructor() {
    this.restoreDraft();
    // Autosave the form so a reload doesn't lose a long prompt.
    effect(() => {
      const draft = {
        model: this.model(), prompt: this.prompt(), duration: this.duration(), resolution: this.resolution(),
        ratio: this.ratio(), expansion: this.expansion(), useCast: this.useCast(),
        refs: this.refs().filter((r) => !r.url.startsWith('data:')), // uploaded files are too big to keep
      };
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage unavailable */ }
    });
    window.addEventListener('focus', () => (document.title = 'Kinowrap'));
  }

  private restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? localStorage.getItem(OLD_DRAFT_KEY) ?? 'null');
      if (!d) return;
      this.model.set(d.model ?? 'MiniMax-H3');
      this.prompt.set(d.prompt ?? '');
      this.duration.set(d.duration ?? 6);
      this.resolution.set(d.resolution ?? '768P');
      this.ratio.set(d.ratio ?? '9:16');
      this.expansion.set(d.expansion ?? 'balanced');
      this.useCast.set(d.useCast ?? true);
      this.refs.set(Array.isArray(d.refs) ? d.refs : []);
    } catch { /* ignore a corrupt draft */ }
  }

  // After the server's rules arrive, make sure a restored draft is valid for its model.
  private clampToModel() {
    const info = this.models()[this.model()];
    if (!info) { this.model.set('MiniMax-H3'); return; }
    if (!(this.resolution() in info.rates)) this.resolution.set(Object.keys(info.rates)[0]);
    if (this.duration() < info.minSeconds) this.duration.set(info.minSeconds);
    this.fitToModel(info);
  }

  // Local H3 has a shorter maximum length and only two aspect ratios.
  private fitToModel(info: ModelInfo) {
    if (this.duration() > (info.maxSeconds ?? 15)) this.duration.set(info.maxSeconds ?? 15);
    if (info.ratios && this.ratio() !== 'adaptive' && !info.ratios.includes(this.ratio())) this.ratio.set(info.ratios[0]);
  }

  ngOnInit() {
    this.loadStatus().then(() => { this.clampToModel(); this.refreshEstimate(); }).catch(() => this.refreshEstimate());
    this.loadHistory().then(() => this.ensurePolling()).catch(() => {});
    this.loadLibrary().catch(() => {});
  }

  private body() {
    return {
      model: this.model(),
      prompt: this.effectivePrompt(),
      castBlock: this.castBlock(),
      duration: this.duration(),
      resolution: this.resolution(),
      ratio: this.effectiveRatio(),
      expansion: this.expansion(),
      refs: this.refs(),
    };
  }

  async refreshEstimate() {
    try {
      this.estimate.set(await firstValueFrom(this.http.post<Estimate>('/api/estimate', this.body())));
      this.error.set('');
      // Picks up the budget and history if the server was started after the page loaded.
      if (!this.status()) {
        this.loadStatus().catch(() => {});
        this.loadHistory().then(() => this.ensurePolling()).catch(() => {});
      }
    } catch (e: any) {
      this.estimate.set(null);
      this.error.set(e.error?.error ?? "Can't reach the local server. Start it with: node --env-file=.env server.mjs (in the server folder).");
    }
  }

  setPrompt(value: string) {
    this.prompt.set(value);
  }

  setModel(name: string) {
    this.model.set(name);
    const info = this.models()[name];
    if (info) {
      if (!(this.resolution() in info.rates)) this.resolution.set(Object.keys(info.rates)[0]);
      if (this.duration() < info.minSeconds) this.duration.set(info.minSeconds);
      this.fitToModel(info);
    }
    this.refreshEstimate();
  }

  set(key: 'duration' | 'resolution' | 'ratio' | 'expansion', value: any) {
    (this[key] as any).set(key === 'duration' ? Number(value) : value);
    if (key === 'resolution' && this.duration() > this.maxSeconds()) this.duration.set(this.maxSeconds()); // e.g. local 768p is shorter
    this.refreshEstimate();
  }

  async loadStatus() {
    this.status.set(await firstValueFrom(this.http.get<Status>('/api/status')));
  }

  async loadHistory() {
    const jobs = (await firstValueFrom(this.http.get<{ jobs: Job[] }>('/api/history'))).jobs;
    for (const j of jobs) {
      const before = this.lastStatus.get(j.id);
      if (before === 'processing' && j.status !== 'processing') this.notify(j);
      this.lastStatus.set(j.id, j.status);
    }
    this.jobs.set(jobs);
  }

  private notify(job: Job) {
    const text = job.status === 'succeeded' ? 'Your video is ready' : `Job ${job.status}`;
    document.title = `${job.status === 'succeeded' ? '✓' : '!'} ${text} — Kinowrap`;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Kinowrap', { body: `${text}: ${job.prompt.slice(0, 80)}` });
      }
    } catch { /* notifications unavailable */ }
  }

  // The app can't read your MiniMax balance, so you tell it what the billing page says.
  async setBalance() {
    const s = this.status();
    const answer = prompt(
      'Enter your current balance from platform.minimax.io → Account → Billing (e.g. 23.47).\nLater jobs are subtracted from this number.',
      s ? s.remaining.toFixed(2) : '',
    );
    if (answer === null) return;
    try {
      await firstValueFrom(this.http.post('/api/balance', { balance: Number(answer.replace(/[$,\s]/g, '')) }));
      await this.loadStatus();
      this.refreshEstimate();
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Could not save the balance.');
    }
  }

  // Mark a job as not charged (e.g. it failed and MiniMax didn't bill it), or charged again.
  async toggleRefunded(job: Job) {
    await firstValueFrom(this.http.post(`/api/jobs/${job.id}/refunded`, { refunded: !job.refunded }));
    await Promise.all([this.loadStatus(), this.loadHistory()]);
    this.refreshEstimate();
  }

  // ---- references ----------------------------------------------------------------------------

  // The last part of a link is the file name, which is the bit you recognise ("…/refs/characters/face.png" -> "face.png").
  fileName(url: string) {
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).pop();
      return last ? decodeURIComponent(last) : url;
    } catch {
      return url.slice(0, 60);
    }
  }

  // Older entries were saved with a shortened link as their name, so derive it again from the link.
  displayName(r: Ref) {
    return /^https?:\/\//.test(r.url) ? this.fileName(r.url) : r.name;
  }

  refTitle(r: Ref) {
    return /^https?:\/\//.test(r.url) ? r.url : r.name;
  }

  // URL text typed into an image slot but not yet added as a reference.
  pending = signal<Partial<Record<Role, string>>>({});
  pendingCount = computed(() => Object.values(this.pending()).filter((v) => v?.trim()).length);

  setPending(role: Role, value: string) {
    this.pending.update((p) => ({ ...p, [role]: value }));
  }

  commitPending(role: Role) {
    const url = this.pending()[role]?.trim();
    if (!url) return;
    this.refs.update((r) => [...r, { type: 'image', role, url, name: this.fileName(url) }]);
    this.pending.update((p) => ({ ...p, [role]: '' }));
    this.refreshEstimate();
  }

  addUrl(type: RefType, role: Role, input: HTMLInputElement, secsInput?: HTMLInputElement) {
    const url = input.value.trim();
    if (!url) return;
    const secs = secsInput?.value.trim();
    this.refs.update((r) => [...r, { type, role, url, name: this.fileName(url), seconds: secs ? Number(secs) : undefined }]);
    input.value = '';
    this.refreshEstimate();
  }

  private readDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private imageSize(dataUrl: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null); // e.g. HEIC isn't decodable in every browser
      img.src = dataUrl;
    });
  }

  private mediaSeconds(file: File, type: 'video' | 'audio'): Promise<number | null> {
    return new Promise((resolve) => {
      const el = document.createElement(type);
      const url = URL.createObjectURL(file);
      el.preload = 'metadata';
      el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Math.round(el.duration * 10) / 10); };
      el.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      el.src = url;
    });
  }

  async addImageFile(role: Role, ev: Event) {
    const input = ev.target as HTMLInputElement;
    const lim = this.limits();
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      if (lim && file.size > lim.imageBytes) {
        this.error.set(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; images can be at most ${lim.imageBytes / 1048576} MB.`);
        continue;
      }
      const url = await this.readDataUrl(file);
      const dims = await this.imageSize(url);
      if (dims) {
        const aspect = dims.width / dims.height;
        if (Math.min(dims.width, dims.height) < 256 || Math.max(dims.width, dims.height) > 5760 || aspect < 0.4 || aspect > 2.5) {
          this.error.set(`${file.name} is ${dims.width}×${dims.height}. Images must be 256–5760 px with an aspect ratio between 0.4 and 2.5.`);
          continue;
        }
      }
      this.refs.update((r) => [...r, { type: 'image', role, url, name: file.name }]);
    }
    this.refreshEstimate();
  }

  async addMediaFile(type: 'video' | 'audio', ev: Event) {
    const input = ev.target as HTMLInputElement;
    const lim = this.limits();
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      const cap = lim ? (type === 'video' ? lim.videoBytes : lim.audioBytes) : Infinity;
      if (file.size > cap) {
        this.error.set(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; ${type} files can be at most ${cap / 1048576} MB. Use a URL for large files.`);
        continue;
      }
      const seconds = await this.mediaSeconds(file, type);
      if (seconds == null && type === 'video') {
        this.error.set(`Couldn't read the length of ${file.name}. Add it by URL with the length filled in instead.`);
        continue;
      }
      if (seconds != null && lim && (seconds < lim.clipMin || seconds > lim.clipMax)) {
        this.error.set(`${file.name} is ${seconds}s. Clips must be ${lim.clipMin}-${lim.clipMax} seconds.`);
        continue;
      }
      const url = await this.readDataUrl(file);
      this.refs.update((r) => [...r, { type, role: type === 'video' ? 'reference_video' : 'reference_audio', url, name: file.name, seconds: seconds ?? undefined }]);
    }
    this.refreshEstimate();
  }

  removeRef(i: number) {
    this.refs.update((r) => r.filter((_, idx) => idx !== i));
    this.refreshEstimate();
  }

  // ---- generating ----------------------------------------------------------------------------

  async generate() {
    // Anything typed into a URL box counts, even if Add URL wasn't clicked.
    for (const role of Object.keys(this.pending()) as Role[]) this.commitPending(role);
    await this.refreshEstimate();
    const est = this.estimate();
    if (!est) return;
    const n = this.refs().length;
    const refText = n ? `${n} reference(s) attached` : 'NO references attached';
    const ask = this.isLocal()
      ? `Run a ${this.duration()}s clip on your own GPU? It is free but slow, and local jobs run one at a time.`
      : `${this.modeLabel()} for $${est.total.toFixed(2)} with ${refText}? This is charged to your MiniMax balance.`;
    if (!confirm(ask)) return;
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    this.busy.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.http.post('/api/generate', { ...this.body(), confirmedTotal: est.total }));
      await Promise.all([this.loadStatus(), this.loadHistory()]);
      this.ensurePolling();
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Request failed.');
    } finally {
      this.busy.set(false);
    }
  }

  // Load a past job's prompt and settings back into the form (references aren't kept).
  // Turn remembered references back into live ones; saved uploads are fetched and re-encoded as before.
  private async rehydrate(stored: StoredRef[] = []): Promise<Ref[]> {
    const out: Ref[] = [];
    let missing = 0;
    for (const r of stored) {
      if (r.url) { out.push({ type: r.type, role: r.role, url: r.url, name: r.name ?? this.fileName(r.url), seconds: r.seconds, character: r.character }); continue; }
      if (r.file) {
        try {
          const blob = await (await fetch(`/refs/${r.file}`)).blob();
          const url = await this.readDataUrl(new File([blob], r.name ?? r.file, { type: blob.type }));
          out.push({ type: r.type, role: r.role, url, name: r.name ?? r.file, seconds: r.seconds, character: r.character });
          continue;
        } catch { /* fall through */ }
      }
      missing++;
    }
    if (missing) this.error.set(`${missing} reference(s) could not be restored. Jobs from before references were saved don't have them.`);
    return out;
  }

  async reuse(job: Job) {
    const name = job.model && this.models()[job.model] ? job.model : 'MiniMax-H3';
    const info = this.models()[name];
    this.model.set(name);
    // Drop the auto-written cast lines; they're rebuilt from the restored references.
    const raw = job.castBlock && job.prompt.startsWith(job.castBlock) ? job.prompt.slice(job.castBlock.length).replace(/^\s+/, '') : job.prompt;
    this.prompt.set(raw);
    if (job.castBlock) this.useCast.set(true);
    this.duration.set(Math.max(job.duration, info?.minSeconds ?? 4));
    this.resolution.set(info && job.resolution in info.rates ? job.resolution : Object.keys(info?.rates ?? { '768P': 0 })[0]);
    if (job.ratio && job.ratio !== 'adaptive') this.ratio.set(job.ratio);
    this.expansion.set(job.expansion ?? 'balanced');
    this.error.set('');
    this.refs.set(await this.rehydrate(job.refs));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.refreshEstimate();
  }

  upgradeTitle(job: Job) {
    return job.upgrade ? job.upgrade.lines.map((l) => `${l.label}: $${l.cost.toFixed(2)}`).join('\n') : '';
  }

  // Upscaling is only offered for finished 480p clips made by the local model, never for MiniMax jobs.
  canUpscale(job: Job) {
    return job.model === 'local-h3' && job.type !== 'upscale' && !!job.file && job.status === 'succeeded' && job.resolution === '480P'
      && !!this.models()['local-h3']?.canUpscale;
  }

  setUpscaler(id: string) {
    this.upscaler.set(id);
    try { localStorage.setItem('kinowrap.upscaler', id); } catch { /* storage can be unavailable */ }
  }

  upscalerLabel(job: Job) {
    return this.upscalers().find((u) => u.id === job.upscaler)?.label ?? '';
  }

  async upscale(job: Job) {
    const u = this.upscalers().find((x) => x.id === this.chosenUpscaler());
    if (!u) return;
    if (!confirm(`Upscale this clip to 768p with "${u.label}"? It is free and runs on your GPU (roughly ${this.fmtTime(u.perSecond * job.duration)} for this clip), and the result is saved as a new clip.`)) return;
    this.error.set('');
    try {
      await firstValueFrom(this.http.post(`/api/jobs/${job.id}/upscale`, { model: u.id }));
      await Promise.all([this.loadStatus(), this.loadHistory()]);
      this.ensurePolling();
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Upscale failed.');
    }
  }

  async upgrade(job: Job) {
    const up = job.upgrade;
    if (!up) return;
    const detail = up.lines.map((l) => `  ${l.label}: $${l.cost.toFixed(2)}`).join('\n');
    if (!confirm(`Regenerate this ${job.duration}s clip at 2K for $${up.total.toFixed(2)}?\n${detail}\n\nThis is charged to your MiniMax balance.`)) return;
    this.error.set('');
    try {
      await firstValueFrom(this.http.post('/api/upgrade', { taskId: job.id, confirmedTotal: up.total }));
      await Promise.all([this.loadStatus(), this.loadHistory()]);
      this.ensurePolling();
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Upgrade failed.');
    }
  }

  // 75 -> "1m 15s", 5400 -> "1h 30m"
  fmtTime(seconds: number) {
    const s = Math.max(0, Math.round(seconds));
    return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  since(iso?: string) {
    return iso ? this.fmtTime((Date.now() - new Date(iso).getTime()) / 1000) : 'a moment';
  }

  modelLabel(job: Job) {
    if (job.type === 'stitch') return 'Stitched';
    return this.models()[job.model ?? 'MiniMax-H3']?.label ?? 'H3';
  }

  usageText(job: Job) {
    const u = job.usage;
    if (!u) return '';
    const out = u.output_seconds ?? u.total_seconds;
    return out != null ? `MiniMax metered ${out}s${u.input_seconds ? ` + ${u.input_seconds}s input` : ''}` : '';
  }

  // ---- per-job actions --------------------------------------------------------------------------

  private async afterJobChange() {
    await Promise.all([this.loadStatus(), this.loadHistory()]);
    this.refreshEstimate();
  }

  async cancelJob(job: Job) {
    if (!confirm(job.model === 'local-h3' ? 'Cancel this local job? A running job is stopped and its progress is lost.' : 'Cancel this queued job? MiniMax says cancelling a queued task is not charged.')) return;
    try {
      await firstValueFrom(this.http.post(`/api/jobs/${job.id}/cancel`, {}));
      await this.afterJobChange();
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Could not cancel.');
    }
  }

  async hideJob(job: Job) {
    await firstValueFrom(this.http.post(`/api/jobs/${job.id}/hide`, { hidden: !job.hidden }));
    await this.loadHistory();
  }

  async deleteFile(job: Job) {
    if (!confirm('Delete the downloaded video file from this computer? The job and its cost stay in your history.')) return;
    await firstValueFrom(this.http.post(`/api/jobs/${job.id}/delete-file`, {}));
    this.selected.update((s) => s.filter((id) => id !== job.id));
    await this.loadHistory();
  }

  isSelected(job: Job) {
    return this.selected().includes(job.id);
  }

  toggleSelect(job: Job) {
    this.selected.update((s) => (s.includes(job.id) ? s.filter((id) => id !== job.id) : [...s, job.id]));
  }

  async stitchSelected() {
    const ids = this.selected();
    if (ids.length < 2) return;
    this.stitching.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.http.post('/api/stitch', { ids }));
      this.selected.set([]);
      await this.loadHistory();
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Stitching failed.');
    } finally {
      this.stitching.set(false);
    }
  }

  // Start the next clip from this clip's final frame (keeps the look; motion and audio don't carry over).
  async continueFrom(job: Job) {
    this.error.set('');
    try {
      const { url } = await firstValueFrom(this.http.post<{ url: string }>(`/api/jobs/${job.id}/last-frame`, {}));
      const blob = await (await fetch(url)).blob();
      const dataUrl = await this.readDataUrl(new File([blob], 'last-frame.png', { type: blob.type || 'image/png' }));
      await this.reuse(job);
      this.refs.set([{ type: 'image', role: 'first_frame', url: dataUrl, name: 'last frame of previous clip' }]);
      this.refreshEstimate();
    } catch (e: any) {
      this.error.set(e.error?.error ?? "Couldn't grab the last frame.");
    }
  }

  // ---- library -------------------------------------------------------------------------------------

  async loadLibrary() {
    this.library.set((await firstValueFrom(this.http.get<{ items: LibraryItem[] }>('/api/library'))).items);
  }

  async savePrompt() {
    if (!this.prompt().trim()) { this.error.set('Write a prompt first.'); return; }
    const name = window.prompt('Name for this prompt?', this.prompt().trim().slice(0, 40));
    if (!name) return;
    await this.saveLibrary({ kind: 'prompt', name, prompt: this.prompt(), refs: this.refs() });
  }

  async saveRefSet() {
    if (!this.refs().length) { this.error.set('Add some references first.'); return; }
    const name = window.prompt('Name for this reference set (e.g. a character)?');
    if (!name) return;
    await this.saveLibrary({ kind: 'refset', name, refs: this.refs() });
  }

  private async saveLibrary(item: object) {
    try {
      this.library.set((await firstValueFrom(this.http.post<{ items: LibraryItem[] }>('/api/library', item))).items);
      this.error.set('');
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Could not save.');
    }
  }

  async useItem(item: LibraryItem) {
    this.error.set('');
    if (item.kind === 'prompt') {
      this.prompt.set(item.prompt ?? '');
      if (item.refs?.length) this.refs.set(await this.rehydrate(item.refs)); // a prompt saved with references brings them back
    } else {
      this.refs.set(await this.rehydrate(item.refs));
    }
    this.refreshEstimate();
  }

  async deleteItem(item: LibraryItem) {
    if (!confirm(`Delete "${item.name}" from your library?`)) return;
    this.library.set((await firstValueFrom(this.http.delete<{ items: LibraryItem[] }>(`/api/library/${item.id}`))).items);
  }

  // ---- insights ---------------------------------------------------------------------------------

  onInsightsToggle(ev: Event) {
    if ((ev.target as HTMLDetailsElement).open) this.loadStats();
  }

  async loadStats() {
    this.stats.set(await firstValueFrom(this.http.get<Stats>('/api/stats')));
  }

  async reconcile() {
    this.reconciling.set(true);
    this.error.set('');
    try {
      this.report.set(await firstValueFrom(this.http.post<Report>('/api/reconcile', {})));
      await Promise.all([this.loadStatus(), this.loadHistory(), this.loadStats()]);
    } catch (e: any) {
      this.error.set(e.error?.error ?? 'Reconcile failed.');
    } finally {
      this.reconciling.set(false);
    }
  }

  async markUnmetered() {
    const r = this.report();
    if (!r?.failedUnmetered.length) return;
    const total = r.failedUnmetered.reduce((t, f) => t + f.cost, 0);
    if (!confirm(`Mark ${r.failedUnmetered.length} failed job(s) ($${total.toFixed(2)}) as not charged?\n\nMiniMax reports no usage for them, which suggests they were free. Check your billing page before relying on that.`)) return;
    await firstValueFrom(this.http.post('/api/refund-many', { ids: r.failedUnmetered.map((f) => f.id) }));
    this.report.set({ ...r, failedUnmetered: [] });
    await Promise.all([this.loadStatus(), this.loadHistory(), this.loadStats()]);
  }

  private ensurePolling() {
    if (this.timer || !this.jobs().some((j) => j.status === 'processing')) return;
    this.timer = setInterval(async () => {
      const pending = this.jobs().filter((j) => j.status === 'processing');
      if (!pending.length) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      for (const j of pending) {
        try { await firstValueFrom(this.http.get(`/api/tasks/${j.id}`)); } catch { /* try again next tick */ }
      }
      await this.loadHistory();
    }, 10000);
  }
}
