const LOGIN = process.env.DATAFORSEO_LOGIN ?? '';
const PASSWORD = process.env.DATAFORSEO_PASSWORD ?? '';
const BASE = 'https://api.dataforseo.com';
const LOCATION_CODE = parseInt(process.env.DATAFORSEO_LOCATION_CODE ?? '2840', 10);

if (!LOGIN || !PASSWORD) {
  console.error('FATAL: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set.');
  process.exit(1);
}

function auth(): string {
  return 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
}

function baseHeaders(): Record<string, string> {
  return {
    Authorization: auth(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Wellows-MCP-Server/1.0 (contact: support@wellows.com)',
  };
}

function positionWeight(pos: number): number {
  const weights: Record<number, number> = { 1: 10, 2: 9, 3: 8, 4: 7, 5: 6 };
  return weights[pos] ?? Math.max(1, 6 - (pos - 5));
}

export interface RawAIOSource {
  url: string;
  title: string;
  domain: string;
  position: number;
  position_weight: number;
}

export interface RawAIOResult {
  query: string;
  aio_triggered: boolean;
  aio_text: string;
  sources: RawAIOSource[];
}

// ── DataForSEO response shapes (partial) ────────────────────────────────────

interface DFSElement {
  type: string;
  url?: string;
  title?: string;
  domain?: string;
}

interface DFSItem {
  type: string;
  text?: string;
  items?: DFSElement[];
}

interface DFSTaskResult {
  keyword?: string;
  items?: DFSItem[];
}

interface DFSTaskPostTask {
  id: string;
  status_code: number;
  status_message?: string;
  data?: { keyword?: string };
}

interface DFSTaskPostResponse {
  tasks?: DFSTaskPostTask[];
}

interface DFSTasksReadyTask {
  id: string;
  status_code: number;
}

interface DFSTasksReadyResponse {
  tasks?: DFSTasksReadyTask[];
}

interface DFSTaskGetTask {
  id: string;
  status_code: number;
  result?: DFSTaskResult[];
}

interface DFSTaskGetResponse {
  tasks?: DFSTaskGetTask[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseAIOFromItems(items: DFSItem[]): Omit<RawAIOResult, 'query'> {
  const aioBlock = items.find(item => item.type === 'ai_overview');
  if (!aioBlock) return { aio_triggered: false, aio_text: '', sources: [] };

  const sources: RawAIOSource[] = (aioBlock.items ?? [])
    .filter(el => el.type === 'ai_overview_element' && el.url)
    .map((el, idx) => {
      const pos = idx + 1;
      let domain = el.domain ?? '';
      if (!domain && el.url) {
        try { domain = new URL(el.url).hostname.replace(/^www\./, ''); } catch { domain = ''; }
      }
      return { url: el.url!, title: el.title ?? '', domain, position: pos, position_weight: positionWeight(pos) };
    });

  return { aio_triggered: true, aio_text: aioBlock.text ?? '', sources };
}

// ── Step 1: Submit all queries as tasks (single fast POST) ───────────────────

async function submitTasks(keywords: string[]): Promise<Map<string, string>> {
  // Returns Map<taskId, keyword>
  const payload = keywords.map(kw => ({
    keyword: kw,
    location_code: LOCATION_CODE,
    language_code: 'en',
    device: 'desktop',
    os: 'windows',
  }));

  const res = await fetch(`${BASE}/v3/serp/google/organic/task_post`, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(18_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DataForSEO task_post ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }

  const data = await res.json() as DFSTaskPostResponse;
  const taskMap = new Map<string, string>();

  for (let i = 0; i < keywords.length; i++) {
    const task = data.tasks?.[i];
    // 20100 = task created successfully
    if (task && (task.status_code === 20100 || task.status_code === 20000)) {
      taskMap.set(task.id, keywords[i]);
    }
  }

  return taskMap;
}

// ── Step 2: Poll tasks_ready until all our tasks complete or deadline ────────

const POLL_INTERVAL_MS = 5_000;
const POLL_DEADLINE_MS = 90_000;

async function waitForTasks(taskIdToKeyword: Map<string, string>): Promise<Set<string>> {
  const pending = new Set(taskIdToKeyword.keys());
  const ready = new Set<string>();
  const deadline = Date.now() + POLL_DEADLINE_MS;

  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let res: Response;
    try {
      res = await fetch(`${BASE}/v3/serp/google/organic/tasks_ready`, {
        headers: { ...baseHeaders(), 'Content-Type': undefined as unknown as string },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      continue; // transient — retry on next poll
    }

    if (!res.ok) continue;

    const data = await res.json() as DFSTasksReadyResponse;
    for (const task of data.tasks ?? []) {
      if (pending.has(task.id)) {
        ready.add(task.id);
        pending.delete(task.id);
      }
    }
  }

  // Any still-pending tasks timed out — treat as no AIO triggered
  return ready;
}

// ── Step 3: Fetch results for ready tasks in batches of 10 ──────────────────

const GET_BATCH_SIZE = 10;

async function fetchTaskResults(
  readyTaskIds: string[],
  taskIdToKeyword: Map<string, string>
): Promise<Map<string, RawAIOResult>> {
  const resultMap = new Map<string, RawAIOResult>();

  for (let i = 0; i < readyTaskIds.length; i += GET_BATCH_SIZE) {
    const batch = readyTaskIds.slice(i, i + GET_BATCH_SIZE);

    await Promise.all(batch.map(async taskId => {
      const keyword = taskIdToKeyword.get(taskId) ?? '';
      try {
        const res = await fetch(
          `${BASE}/v3/serp/google/organic/task_get/advanced/${taskId}`,
          {
            headers: { ...baseHeaders(), 'Content-Type': undefined as unknown as string },
            signal: AbortSignal.timeout(15_000),
          }
        );

        if (!res.ok) {
          resultMap.set(keyword, { query: keyword, aio_triggered: false, aio_text: '', sources: [] });
          return;
        }

        const data = await res.json() as DFSTaskGetResponse;
        const task = data.tasks?.[0];
        const items = task?.result?.[0]?.items ?? [];
        const parsed = parseAIOFromItems(items);
        resultMap.set(keyword, { query: keyword, ...parsed });
      } catch {
        resultMap.set(keyword, { query: keyword, aio_triggered: false, aio_text: '', sources: [] });
      }
    }));

    // small pause between GET batches
    if (i + GET_BATCH_SIZE < readyTaskIds.length) {
      await sleep(500);
    }
  }

  return resultMap;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchAIOForQueries(
  queries: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, RawAIOResult>> {
  // 1. Submit all queries as async tasks (fast, < 5s)
  const taskIdToKeyword = await submitTasks(queries);
  onProgress?.(0, queries.length);

  if (taskIdToKeyword.size === 0) {
    // All task submissions failed
    const fallback = new Map<string, RawAIOResult>();
    for (const q of queries) {
      fallback.set(q, { query: q, aio_triggered: false, aio_text: '', sources: [] });
    }
    return fallback;
  }

  // 2. Poll until DataForSEO finishes processing (parallel server-side)
  const readyTaskIds = await waitForTasks(taskIdToKeyword);
  onProgress?.(readyTaskIds.size, queries.length);

  // 3. Fetch results for completed tasks (batches of 10, < 15s each)
  const resultMap = await fetchTaskResults([...readyTaskIds], taskIdToKeyword);
  onProgress?.(queries.length, queries.length);

  // Fill in failed/timed-out queries with empty results
  for (const q of queries) {
    if (!resultMap.has(q)) {
      resultMap.set(q, { query: q, aio_triggered: false, aio_text: '', sources: [] });
    }
  }

  return resultMap;
}
