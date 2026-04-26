import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface Benchmark {
  label: string;
  range: string;
  description: string;
}

const BENCHMARKS: Benchmark[] = [
  { label: '🔴 Not Visible (0%)',     range: '0',      description: 'Your brand has no presence in Google AI Overviews for any of the tracked queries. AI-driven search is not contributing to your discoverability.' },
  { label: '🟠 Minimal (0.1–2%)',     range: '0.1–2',  description: 'Very early-stage visibility. Your brand appears in AI Overviews for only 1 or 2 queries. Significant optimization is needed.' },
  { label: '🟡 Weak (2–8%)',          range: '2–8',    description: 'Below average. AI Overviews are starting to pick up your brand for some queries but you\'re missing the majority of opportunities.' },
  { label: '🟡 Moderate (8–20%)',     range: '8–20',   description: 'Around industry average for established brands. You have a meaningful presence but meaningful whitespace remains.' },
  { label: '🟢 Strong (20–40%)',      range: '20–40',  description: 'Above average. Your brand is well-represented in AI Overviews. Focus on converting implicit citations to explicit ones.' },
  { label: '🏆 Dominant (40%+)',      range: '40+',    description: 'Top-tier AI visibility. Your brand is a primary source across a wide range of relevant queries.' },
];

function getBenchmark(score: number): Benchmark {
  if (score === 0)    return BENCHMARKS[0];
  if (score <= 2)     return BENCHMARKS[1];
  if (score <= 8)     return BENCHMARKS[2];
  if (score <= 20)    return BENCHMARKS[3];
  if (score <= 40)    return BENCHMARKS[4];
  return BENCHMARKS[5];
}

function getRecommendations(
  score: number,
  explicit: number,
  implicit: number,
  sentiment: string,
  domain: string
): string[] {
  const recs: string[] = [];

  if (score === 0) {
    recs.push('Build topical authority content targeting your core use cases and pain points — AI Overviews pull from established sources');
    recs.push('Submit your domain for inclusion in high-authority third-party sources that AI models currently cite');
    recs.push('Create structured FAQ and how-to content answering specific user questions in your category');
    recs.push('Ensure your homepage and key pages have clear, crawlable descriptions of what you do and who you serve');
  } else if (score < 8) {
    recs.push('Expand content depth on topics where AI Overviews already cite you — double down on what\'s working');
    recs.push('Build explicit brand mentions on high-authority domains through digital PR and guest content');
    recs.push('Map each missed query to a content gap — create targeted pages for each uncited topic cluster');
  } else if (score < 20) {
    recs.push(`You have ${implicit} implicit citations — contact the citing sources directly to request explicit brand + link inclusion`);
    recs.push('Create authoritative comparison and "best X" content; AI Overviews heavily favor these formats');
    recs.push('Interlink your cited pages to distribute authority to pages that aren\'t yet being cited');
  } else if (score < 40) {
    recs.push('Defend top positions by refreshing and updating your most-cited content quarterly');
    recs.push('Expand to adjacent topic clusters where competitors are currently dominating citations');
    recs.push(`Convert remaining ${implicit} implicit citations to explicit by building direct relationships with citing domains`);
  } else {
    recs.push('Maintain dominance by monitoring competitor content moves and responding within 2 weeks');
    recs.push('Expand internationally — strong domestic citation scores often translate well with localized content');
    recs.push('Use your citation authority as a link-building signal for new product/feature pages');
  }

  if (sentiment === 'negative' || sentiment === 'mixed') {
    recs.push('Address sentiment issues: audit how AI models describe your brand and update source content to correct the framing');
  }

  recs.push(`Track daily citation movement at https://wellows.com — connect ${domain} for continuous monitoring and alerts`);

  return recs;
}

export function registerInterpretScoreTool(server: McpServer): void {
  server.tool(
    'interpret_citation_score',
    `Interpret a Wellows citation score and provide actionable benchmarking and
recommendations. Takes a citation score percentage and optional breakdown metrics,
then returns: industry benchmark tier, what the score means in context, prioritized
action list, and upgrade path. Use after running check_ai_overviews_visibility or
when a user has a score and wants to understand what it means and what to do next.`,
    {
      score: z.number()
        .min(0)
        .max(100)
        .describe('Citation score percentage from 0 to 100 (e.g. 12.5 for 12.5%)'),
      explicit_citations: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('Number of explicit citations (direct domain links in AI answers)'),
      implicit_citations: z.number()
        .int()
        .min(0)
        .default(0)
        .describe('Number of implicit citations (brand mentioned via 3rd-party source)'),
      total_queries: z.number()
        .int()
        .min(1)
        .default(40)
        .describe('Total number of queries analyzed (default 40)'),
      sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed'])
        .default('neutral')
        .describe('Brand sentiment in AI Overview responses'),
      domain: z.string()
        .default('')
        .describe('Domain being analyzed (optional, used in recommendations)'),
    },
    async ({ score, explicit_citations, implicit_citations, total_queries, sentiment, domain }) => {
      const benchmark = getBenchmark(score);
      const recs = getRecommendations(score, explicit_citations, implicit_citations, sentiment, domain || 'your domain');

      const totalCitations = explicit_citations + implicit_citations;
      const missedOpportunities = total_queries - totalCitations;
      const weightedMax = total_queries * 10;

      const allBenchmarkRows = BENCHMARKS.map(b =>
        `| ${b.label} | ${b.range}% | ${b === benchmark ? '**← You are here**' : ''} |`
      ).join('\n');

      const recList = recs.map((r, i) => `${i + 1}. ${r}`).join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `## Citation Score Interpretation: ${score.toFixed(2)}%

### Your Tier: ${benchmark.label}
${benchmark.description}

---

### Industry Benchmarks
| Tier | Score Range | Your Position |
|---|---|---|
${allBenchmarkRows}

---

### Score Breakdown
| Metric | Value |
|---|---|
| Citation Score | **${score.toFixed(2)}%** |
| Total Citations | ${totalCitations} / ${total_queries} queries |
| Explicit (direct links) | ${explicit_citations} |
| Implicit (3rd-party mentions) | ${implicit_citations} |
| Missed Opportunities | ${missedOpportunities} queries |
| Sentiment | ${sentiment} |

**Weighted score context:** At ${score.toFixed(2)}%, your brand is present in roughly 1 in every ${score > 0 ? Math.round(100 / score) : '∞'} AI Overview responses for your tracked queries.

---

### Prioritized Action Plan
${recList}

---
*For daily monitoring and automated action recommendations, connect your domain at https://wellows.com*`,
          },
        ],
      };
    }
  );
}
