import { ScrapeDomainResponse, JobInitResponse, ExtractEntitiesCompleted,
  GenerateQueriesCompleted, GeneratedQuery, CitationSource, CitationType,
  QueryResult, AIOSource, CitationAnalysis, SentimentType } from '../types/index.js';
import { fetchAIOForQueries } from './dataForSeoClient.js';

const BASE_URL = process.env.WELLOWS_BASE_URL ?? 'https://wellows.com';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000;

const PATHS = {
  scrape:   process.env.API_PATH_SCRAPE   ?? '',
  entities: process.env.API_PATH_ENTITIES ?? '',
  queries:  process.env.API_PATH_QUERIES  ?? '',
};

if (Object.values(PATHS).some(p => !p)) {
  console.error('FATAL: API_PATH_SCRAPE, API_PATH_ENTITIES, API_PATH_QUERIES must all be set.');
  process.exit(1);
}

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
  return postJSON<ScrapeDomainResponse>(PATHS.scrape, {
    domain: domainUrl,
  });
}

// ─── Step 2: Extract Entities ─────────────────────────────────────────────────

export async function extractEntities(
  scrapeData: ScrapeDomainResponse,
  onProgress?: (status: string, elapsed: number) => void
): Promise<ExtractEntitiesCompleted> {
  const init = await postJSON<JobInitResponse>(PATHS.entities, scrapeData);

  return pollUntilComplete<ExtractEntitiesCompleted>(
    `${PATHS.entities}?jobId=${encodeURIComponent(init.jobId)}`,
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
  const init = await postJSON<JobInitResponse>(PATHS.queries, merged);

  return pollUntilComplete<GenerateQueriesCompleted>(
    `${PATHS.queries}?jobId=${encodeURIComponent(init.jobId)}`,
    onProgress
  );
}

// ─── Step 4: AIO Search via DataForSEO ───────────────────────────────────────

export async function runAIOSearches(
  queries: GeneratedQuery[],
  scrapeData: ScrapeDomainResponse,
  onProgress?: (completed: number, total: number) => void
): Promise<Record<string, QueryResult>> {
  const targetDomain = scrapeData.domain.toLowerCase().replace(/^www\./, '');
  const brandLower = scrapeData.brandName.toLowerCase();

  const aioMap = await fetchAIOForQueries(
    queries.map(q => q.text),
    onProgress
  );

  const results: Record<string, QueryResult> = {};

  for (const q of queries) {
    const aio = aioMap.get(q.text);

    if (!aio || !aio.aio_triggered) {
      results[q.id] = {
        query_id: q.id,
        query_text: q.text,
        intent: q.intent,
        persona_id: q.persona_id,
        aio_triggered: false,
        aio_source_count: 0,
        aio_sources: [],
        aio_text: '',
        found_citation: false,
        domain_appears_directly: false,
        domain_mentioned_in_context: false,
        brand_mentioned: false,
        citation_type: 'none' as CitationType,
        sources: [],
        sentiment: 'neutral',
        related_entities: [],
        competitor_mentions: [],
      };
      continue;
    }

    // Explicit: target domain URL is one of the cited sources
    const matchingSources = aio.sources.filter(s =>
      s.domain === targetDomain ||
      s.domain.endsWith(`.${targetDomain}`) ||
      s.url.toLowerCase().includes(targetDomain)
    );
    const domain_appears_directly = matchingSources.length > 0;

    // Implicit: brand name or domain appears in the AIO text but domain not directly cited
    const aioTextLower = aio.aio_text.toLowerCase();
    const domain_mentioned_in_context = !domain_appears_directly && (
      aioTextLower.includes(brandLower) ||
      aioTextLower.includes(targetDomain)
    );

    const citation_type: CitationType =
      domain_appears_directly ? 'explicit' :
      domain_mentioned_in_context ? 'implicit' :
      'none';

    // All non-target domains in AIO sources = competitors
    const competitor_mentions = [...new Set(
      aio.sources
        .filter(s => s.domain && s.domain !== targetDomain && !s.domain.endsWith(`.${targetDomain}`))
        .map(s => s.domain)
    )];

    // CitationSource entries only for matching (target) sources
    const citationSources: CitationSource[] = matchingSources.map(s => ({
      url: s.url,
      title: s.title,
      excerpt: '',
      confidence: 1.0,
      position: s.position,
      position_weight: s.position_weight,
    }));

    // Map RawAIOSource → AIOSource (same shape, just narrowed type)
    const aio_sources: AIOSource[] = aio.sources.map(s => ({
      url: s.url,
      title: s.title,
      domain: s.domain,
      position: s.position,
      position_weight: s.position_weight,
    }));

    results[q.id] = {
      query_id: q.id,
      query_text: q.text,
      intent: q.intent,
      persona_id: q.persona_id,
      aio_triggered: true,
      aio_source_count: aio.sources.length,
      aio_sources,
      aio_text: aio.aio_text,
      found_citation: domain_appears_directly,
      domain_appears_directly,
      domain_mentioned_in_context,
      brand_mentioned: domain_appears_directly || domain_mentioned_in_context,
      citation_type,
      sources: citationSources,
      sentiment: 'neutral',
      related_entities: [],
      competitor_mentions,
    };
  }

  return results;
}

// ─── Aggregate Results ────────────────────────────────────────────────────────

export function aggregateCitationAnalysis(
  domain: string,
  queries: GeneratedQuery[],
  aioResults: Record<string, QueryResult>
): CitationAnalysis {
  const results = queries.map(q => aioResults[q.id]).filter(Boolean);

  const aioTriggeredCount = results.filter(r => r.aio_triggered).length;
  const directCitations = results.filter(r => r.citation_type === 'explicit').length;
  const thirdPartyCitations = results.filter(r => r.citation_type === 'implicit').length;
  const totalCitations = directCitations + thirdPartyCitations;

  let weightedScore = 0;
  const positionDist = { position_1: 0, position_2: 0, position_3: 0, position_4: 0, position_5: 0 };
  const competitorPresence: Record<string, { mentions: number; queries: string[] }> = {};
  const sentimentCounts: Record<string, number> = {};

  for (const result of results) {
    if (result.found_citation) {
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
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral') as SentimentType;

  return {
    domain,
    total_queries: totalQueries,
    aio_triggered_count: aioTriggeredCount,
    aio_trigger_rate: totalQueries > 0 ? aioTriggeredCount / totalQueries : 0,
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
