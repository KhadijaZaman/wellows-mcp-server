import { ScrapeDomainResponse, JobInitResponse, ExtractEntitiesCompleted,
  GenerateQueriesCompleted, GeneratedQuery, SerpSearchResponse,
  ExtractEntitiesPollResponse, GenerateQueriesPollResponse } from '../types/index.js';

const BASE_URL = process.env.WELLOWS_BASE_URL ?? 'https://wellows.com';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000; // 3 minutes per step

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Wellows-MCP-Server/1.0',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WellowsAPIError(`POST ${path} failed: ${res.status} ${res.statusText}`, res.status, text);
  }

  return res.json() as Promise<T>;
}

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Wellows-MCP-Server/1.0' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WellowsAPIError(`GET ${path} failed: ${res.status} ${res.statusText}`, res.status, text);
  }

  return res.json() as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class WellowsAPIError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = 'WellowsAPIError';
  }
}

// ─── Poll until completed ─────────────────────────────────────────────────────

async function pollUntilComplete<T extends { status: string }>(
  path: string,
  onProgress?: (status: string, elapsed: number) => void
): Promise<T> {
  const start = Date.now();
  const deadline = start + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const data = await getJSON<T & { error?: string }>(path);
    const elapsed = Math.round((Date.now() - start) / 1000);

    if (data.status === 'completed') {
      return data;
    }

    if (data.status === 'failed') {
      throw new WellowsAPIError(
        `Job failed: ${data.error ?? 'Unknown error'}`,
        500,
        JSON.stringify(data)
      );
    }

    onProgress?.(data.status, elapsed);
  }

  throw new WellowsAPIError('Job polling timed out after 3 minutes', 408, '');
}

// ─── Step 1: Scrape Domain ────────────────────────────────────────────────────

export async function scrapeDomain(domainUrl: string): Promise<ScrapeDomainResponse> {
  return postJSON<ScrapeDomainResponse>('/api/isqgt/scrape-domain', {
    domain: domainUrl,
  });
}

// ─── Step 2: Extract Entities ─────────────────────────────────────────────────

export async function extractEntities(
  scrapeData: ScrapeDomainResponse,
  onProgress?: (status: string, elapsed: number) => void
): Promise<ExtractEntitiesCompleted> {
  const init = await postJSON<JobInitResponse>('/api/isqgt/extract-entities', scrapeData);

  return pollUntilComplete<ExtractEntitiesCompleted>(
    `/api/isqgt/extract-entities?jobId=${encodeURIComponent(init.jobId)}`,
    onProgress
  );
}

// ─── Step 3: Generate Queries ─────────────────────────────────────────────────

export async function generateQueries(
  scrapeData: ScrapeDomainResponse,
  entitiesData: ExtractEntitiesCompleted,
  onProgress?: (status: string, elapsed: number) => void
): Promise<GenerateQueriesCompleted> {
  const merged = { ...scrapeData, ...entitiesData };
  const init = await postJSON<JobInitResponse>('/api/isqgt/generate-queries', merged);

  return pollUntilComplete<GenerateQueriesCompleted>(
    `/api/isqgt/generate-queries?jobId=${encodeURIComponent(init.jobId)}`,
    onProgress
  );
}

// ─── Step 4: SERP Search (batched parallel) ───────────────────────────────────

const SERP_BATCH_SIZE = 5;
const SERP_BATCH_DELAY_MS = 500;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function runSerpSearches(
  queries: GeneratedQuery[],
  scrapeData: ScrapeDomainResponse,
  onProgress?: (completed: number, total: number) => void
): Promise<Record<string, import('../types/index.js').QueryResult>> {
  const batches = chunkArray(queries, SERP_BATCH_SIZE);
  const allResults: Record<string, import('../types/index.js').QueryResult> = {};
  let completedQueries = 0;

  for (const batch of batches) {
    const response = await postJSON<SerpSearchResponse>(
      '/api/ai-overviews-tracker/serp-search/',
      {
        queries: batch,
        domain: scrapeData.domain,
        brandName: scrapeData.brandName,
        domainContent: scrapeData.domainContent,
      }
    );

    if (response.success && response.results) {
      Object.assign(allResults, response.results);
    }

    completedQueries += batch.length;
    onProgress?.(completedQueries, queries.length);

    if (batches.indexOf(batch) < batches.length - 1) {
      await sleep(SERP_BATCH_DELAY_MS);
    }
  }

  return allResults;
}

// ─── Aggregate Results ────────────────────────────────────────────────────────

export function aggregateCitationAnalysis(
  domain: string,
  queries: GeneratedQuery[],
  serpResults: Record<string, import('../types/index.js').QueryResult>
): import('../types/index.js').CitationAnalysis {
  const results = queries.map(q => serpResults[q.id]).filter(Boolean);

  const directCitations = results.filter(r => r.citation_type === 'explicit').length;
  const thirdPartyCitations = results.filter(r => r.citation_type === 'implicit').length;
  const totalCitations = directCitations + thirdPartyCitations;

  let weightedScore = 0;
  const positionDist = { position_1: 0, position_2: 0, position_3: 0, position_4: 0, position_5: 0 };
  const competitorPresence: Record<string, { mentions: number; queries: string[] }> = {};
  const sentimentCounts: Record<string, number> = {};

  for (const result of results) {
    if (result.found_citation || result.brand_mentioned) {
      for (const source of result.sources) {
        if (source.position >= 1 && source.position <= 5) {
          const key = `position_${source.position}` as keyof typeof positionDist;
          positionDist[key]++;
          weightedScore += source.position_weight;
        }
      }
    }

    for (const competitor of result.competitor_mentions ?? []) {
      if (!competitorPresence[competitor]) {
        competitorPresence[competitor] = { mentions: 0, queries: [] };
      }
      competitorPresence[competitor].mentions++;
      competitorPresence[competitor].queries.push(result.query_text);
    }

    const s = result.sentiment ?? 'neutral';
    sentimentCounts[s] = (sentimentCounts[s] ?? 0) + 1;
  }

  const totalQueries = queries.length;
  const citationRate = totalQueries > 0 ? totalCitations / totalQueries : 0;
  const maxScore = totalQueries * 10;
  const weightedRate = maxScore > 0 ? weightedScore / maxScore : 0;

  const avgSentiment = (Object.entries(sentimentCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral') as import('../types/index.js').SentimentType;

  return {
    domain,
    total_queries: totalQueries,
    citation_rate: citationRate,
    weighted_citation_rate: weightedRate,
    average_sentiment: avgSentiment,
    total_citations: totalCitations,
    direct_citations: directCitations,
    third_party_citations: thirdPartyCitations,
    weighted_citation_score: weightedScore,
    max_possible_weighted_score: maxScore,
    position_distribution: positionDist,
    entity_visibility: {},
    competitor_presence: competitorPresence,
    results,
  };
}
