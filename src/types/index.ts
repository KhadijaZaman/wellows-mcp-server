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

// ── SERP Search ──

export interface SerpSearchRequest {
  queries: GeneratedQuery[];
  domain: string;        // Bare domain: "purevpn.com"
  brandName: string;     // Uppercased: "PUREVPN"
  domainContent: string; // Full scraped content string
}

export interface CitationSource {
  url: string;
  title: string;
  excerpt: string;
  confidence: number;       // Always 0.95 in current impl
  position: number;         // 1-based position in AI Overview sources
  position_weight: number;  // position→weight: 1→10, 2→9, 3→8, 4→7, 5→6
}

export type CitationType = 'none' | 'explicit' | 'implicit';
export type SentimentType = 'positive' | 'neutral' | 'negative' | 'mixed';

export interface QueryResult {
  query_id: string;
  query_text: string;
  intent: QueryIntent;
  persona_id: string;
  found_citation: boolean;
  brand_mentioned: boolean;
  citation_type: CitationType;
  sources: CitationSource[];
  sentiment: SentimentType;
  related_entities: string[];
  competitor_mentions: string[]; // Bare domains: ["ftc.gov", "cnet.com"]
}

export interface SerpSearchResponse {
  success: boolean;
  results: Record<string, QueryResult>; // Keyed by query_id
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
  citation_rate: number;           // 0.0 – 1.0
  weighted_citation_rate: number;
  average_sentiment: SentimentType;
  total_citations: number;
  direct_citations: number;        // Explicit citations
  third_party_citations: number;   // Implicit citations
  weighted_citation_score: number;
  max_possible_weighted_score: number; // 400 for 40 queries
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
  avg_citation_position: number | null;
  position_distribution: PositionDistribution;
  sentiment: SentimentType;
  top_competitor_domains: Array<{ domain: string; mentions: number }>;
  top_cited_queries: QueryResult[];
  missed_opportunities: number;
  raw_analysis: CitationAnalysis;
}
