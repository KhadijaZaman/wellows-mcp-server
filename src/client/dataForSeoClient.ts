const LOGIN = process.env.DATAFORSEO_LOGIN ?? '';
const PASSWORD = process.env.DATAFORSEO_PASSWORD ?? '';
const BASE = 'https://api.dataforseo.com';
const LOCATION_CODE = parseInt(process.env.DATAFORSEO_LOCATION_CODE ?? '2840', 10);
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

if (!LOGIN || !PASSWORD) {
  console.error('FATAL: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set.');
  process.exit(1);
}

function auth(): string {
  return 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
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

// DataForSEO response shape (partial — only fields we use)
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
  keyword: string;
  items?: DFSItem[];
}

interface DFSTask {
  id: string;
  status_code: number;
  result?: DFSTaskResult[];
}

interface DFSResponse {
  tasks?: DFSTask[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchBatch(keywords: string[]): Promise<RawAIOResult[]> {
  const payload = keywords.map(kw => ({
    keyword: kw,
    location_code: LOCATION_CODE,
    language_code: 'en',
    device: 'desktop',
    os: 'windows',
  }));

  const res = await fetch(`${BASE}/v3/serp/google/organic/live/advanced`, {
    method: 'POST',
    headers: {
      Authorization: auth(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DataForSEO ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as DFSResponse;
  const out: RawAIOResult[] = [];

  for (let i = 0; i < keywords.length; i++) {
    const task = data.tasks?.[i];
    const query = keywords[i];

    if (!task || task.status_code !== 20000) {
      out.push({ query, aio_triggered: false, aio_text: '', sources: [] });
      continue;
    }

    const items = task.result?.[0]?.items ?? [];
    const aioBlock = items.find(item => item.type === 'ai_overview');

    if (!aioBlock) {
      out.push({ query, aio_triggered: false, aio_text: '', sources: [] });
      continue;
    }

    const sources: RawAIOSource[] = (aioBlock.items ?? [])
      .filter(el => el.type === 'ai_overview_element' && el.url)
      .map((el, idx) => {
        const pos = idx + 1;
        let domain = el.domain ?? '';
        if (!domain && el.url) {
          try { domain = new URL(el.url).hostname.replace(/^www\./, ''); } catch { domain = ''; }
        }
        return {
          url: el.url!,
          title: el.title ?? '',
          domain,
          position: pos,
          position_weight: positionWeight(pos),
        };
      });

    out.push({
      query,
      aio_triggered: true,
      aio_text: aioBlock.text ?? '',
      sources,
    });
  }

  return out;
}

export async function fetchAIOForQueries(
  queries: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, RawAIOResult>> {
  const resultMap = new Map<string, RawAIOResult>();
  const chunks: string[][] = [];

  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    chunks.push(queries.slice(i, i + BATCH_SIZE));
  }

  let completed = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const batch = chunks[ci];
    const batchResults = await fetchBatch(batch);

    for (const r of batchResults) {
      resultMap.set(r.query, r);
    }

    completed += batch.length;
    onProgress?.(completed, queries.length);

    if (ci < chunks.length - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return resultMap;
}
