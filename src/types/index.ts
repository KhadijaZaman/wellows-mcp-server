// All types derived from verified live API payloads

export interface ScrapeDomainRequest {
  domain: string; // Full URL: "https://www.purevpn.com"
}

export interface ScrapingMetadata {
  domain: string;
  homepageTitle: string;
  homepageDescription: string;
  totalContentLength: number;
  pagesScraped: number;
}

export interface ScrapeDomainResponse {
  success: boolean;
  domain: string;           // Normalized: "purevpn.com"
  brandName: string;        // Uppercased: "PUREVPN"
  domainContent: string;    // [SECTION:] [PAGE:] formatted, ~8000 chars
  scrapingSuccess: boolean;
  scrapingMetadata: ScrapingMetadata;
}

// ── Entity Extraction ──

export interface Entity {
  id: string;
  name: string;
  category: 'Brand' | 'Service' | 'Capability' | 'Audience' | string;
  tags: string[];
  description: string;
}

export interface PainPoint {
  id: string;
  title: string;
  explanation: string;
  impact: 'High' | 'Medium' | 'Low';
}

export interface JTBD {
  id: string;
  situation: string;
  task: string;
  desired_outcome: string;
  full_statement: string;
}

export interface Goal {
  id: string;
  category: string;
  title: string;
  description: string;
}

export interface JobInitResponse {
  success: boolean;
  jobId: string;           // Format: "resp_" + 50 hex chars
  status: 'queued';
  message: string;
}

export type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface JobPollInProgress {
  success: boolean;
  status: 'queued' | 'in_progress';
  jobId: string;
}

export interface ExtractEntitiesCompleted {
  success: boolean;
  status: 'completed';
  entities: Entity[];
  painPoints: PainPoint[];
  jtbds: JTBD[];
  goals: Goal[];
}

export type ExtractEntitiesPollResponse = JobPollInProgress | ExtractEntitiesCompleted;

// ── Query Generation ──

export type QueryIntent = 'Informational' | 'Transactional' | 'Navigational' | 'Commercial';
export type QuerySourceType = 'pain_point' | 'entity' | 'jtbd' | 'goal';

export interface GeneratedQuery {
  id: string;           // "query_1", "query_2", ...
  text: string;
  intent: QueryIntent;
  source_type: QuerySourceType;
  persona_id: string;
  volume: number;       // Always 0 in current implementation
  difficulty: number;   // Always 0 in current implementation
  cpc: number;          // Always 0 in current implementation
}

export interface GenerateQueriesCompleted {
  success: boolean;
  status: 'completed';
  queries: GeneratedQuery[];
}

export type GenerateQueriesPollResponse = JobPollInProgress | GenerateQueriesCompleted;

// ── SERP / AIO ──

export interface CitationSource {
  url: string;
  title: string;
  excerpt: string;
  confidence: number;
  position: number;         // 1-based position in AI Overview sources
  position_weight: number;  // 1→10, 2→9, 3→8, 4→7, 5→6, 6+→decreasing
}

// One URL cited by Google AI Overview
export interface AIOSource {
  url: string;
  title: string;
  domain: string;
  position: number;
  position_weight: number;
}

export type CitationType = 'none' | 'explicit' | 'implicit' | 'serp';
export type SentimentType = 'positive' | 'neutral' | 'negative' | 'mixed';

export interface QueryResult {
  query_id: string;
  query_text: string;
  intent: QueryIntent;
  persona_id: string;

  // AIO detection (new)
  aio_triggered: boolean;               // Was AI Overview shown for this query?
  aio_source_count: number;             // How many URLs AIO cited (0 if not triggered)
  aio_sources: AIOSource[];             // All cited URLs returned by DataForSEO
  aio_text: string;                     // Full AI Overview text (empty if not triggered)

  // Domain citation (derived from AIO data)
  found_citation: boolean;              // target domain URL appears in aio_sources
  domain_appears_directly: boolean;     // same as found_citation (explicit)
  domain_mentioned_in_context: boolean; // brand/domain in AIO text via 3rd-party source
  brand_mentioned: boolean;             // found_citation OR domain_mentioned_in_context
  citation_type: CitationType;          // explicit | implicit | none

  // SERP fallback (when aio_triggered = false)
  domain_in_serp: boolean;             // target domain found in organic SERP top 10
  serp_rank: number | null;            // organic position (1-based), null if not found

  // Scoring helpers (only sources matching target domain)
  sources: CitationSource[];
  sentiment: SentimentType;
  related_entities: string[];
  competitor_mentions: string[];        // other domains in aio_sources
}

// kept for backwards-compat with any existing callers
export interface SerpSearchResponse {
  success: boolean;
  results: Record<string, QueryResult>;
  serpDataAvailable: boolean;
  serpError: string | null;
  queriesCount: number;
  processingTimeSeconds: number;
}

// ── Aggregated Citation Analysis ──

export interface PositionDistribution {
  position_1: number;
  position_2: number;
  position_3: number;
  position_4: number;
  position_5: number;
}

export interface CompetitorPresenceEntry {
  mentions: number;
  queries: string[];
}

export interface CitationAnalysis {
  domain: string;
  total_queries: number;
  aio_triggered_count: number;     // queries where AI Overview actually appeared
  aio_trigger_rate: number;        // aio_triggered_count / total_queries
  serp_citations: number;          // queries where AIO not triggered but domain in top-10 organic
  citation_rate: number;           // total_citations / total_queries (0.0–1.0)
  weighted_citation_rate: number;
  average_sentiment: SentimentType;
  total_citations: number;
  direct_citations: number;        // explicit: target domain URL in AIO sources
  third_party_citations: number;   // implicit: brand mentioned in AIO text
  weighted_citation_score: number;
  max_possible_weighted_score: number;
  position_distribution: PositionDistribution;
  entity_visibility: Record<string, unknown>;
  competitor_presence: Record<string, CompetitorPresenceEntry>;
  results: QueryResult[];
}

// ── Final MCP Tool Output ──

export interface VisibilityReport {
  domain: string;
  brand_name: string;
  analyzed_at: string;
  citation_score_pct: number;
  explicit_citations: number;
  implicit_citations: number;
  total_citations: number;
  queries_run: number;
  aio_triggered_count: number;     // queries that actually showed AI Overview
  aio_trigger_rate_pct: number;    // percentage
  serp_citations: number;          // fallback: AIO absent but domain in organic top 10
  avg_citation_position: number | null;
  avg_sources_per_aio: number | null; // avg URLs cited when AIO was triggered
  position_distribution: PositionDistribution;
  sentiment: SentimentType;
  top_competitor_domains: Array<{ domain: string; mentions: number }>;
  top_cited_queries: QueryResult[];
  missed_opportunities: number;    // triggered AIOs where brand not cited
  raw_analysis: CitationAnalysis;
}
