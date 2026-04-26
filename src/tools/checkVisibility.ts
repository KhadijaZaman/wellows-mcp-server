import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  scrapeDomain, extractEntities, generateQueries,
  runSerpSearches, aggregateCitationAnalysis
} from '../client/wellowsClient.js';
import type { VisibilityReport, CitationAnalysis } from '../types/index.js';

function buildVisibilityReport(
  domainUrl: string,
  brandName: string,
  analysis: CitationAnalysis
): VisibilityReport {
  const citedResults = analysis.results.filter(r => r.found_citation || r.brand_mentioned);
  const avgPosition = citedResults.length > 0
    ? citedResults.flatMap(r => r.sources.map(s => s.position))
        .reduce((sum, p) => sum + p, 0) / citedResults.length
    : null;

  const topCompetitors = Object.entries(analysis.competitor_presence)
    .sort((a, b) => b[1].mentions - a[1].mentions)
    .slice(0, 10)
    .map(([domain, data]) => ({ domain, mentions: data.mentions }));

  return {
    domain: analysis.domain,
    brand_name: brandName,
    analyzed_at: new Date().toISOString(),
    citation_score_pct: Math.round(analysis.citation_rate * 10000) / 100,
    explicit_citations: analysis.direct_citations,
    implicit_citations: analysis.third_party_citations,
    total_citations: analysis.total_citations,
    queries_run: analysis.total_queries,
    avg_citation_position: avgPosition !== null ? Math.round(avgPosition * 10) / 10 : null,
    position_distribution: analysis.position_distribution,
    sentiment: analysis.average_sentiment,
    top_competitor_domains: topCompetitors,
    top_cited_queries: citedResults.slice(0, 5),
    missed_opportunities: analysis.total_queries - analysis.total_citations,
    raw_analysis: analysis,
  };
}

function formatReportAsText(report: VisibilityReport): string {
  const score = report.citation_score_pct;
  const grade =
    score >= 25 ? '🟢 Strong' :
    score >= 10 ? '🟡 Moderate' :
    score >= 2  ? '🟠 Weak' :
                  '🔴 Not Visible';

  const posDistLines = Object.entries(report.position_distribution)
    .map(([pos, count]) => `  ${pos.replace('_', ' ').replace('position', 'Position')}: ${count}`)
    .join('\n');

  const competitorLines = report.top_competitor_domains
    .slice(0, 8)
    .map((c, i) => `  ${i + 1}. ${c.domain} — ${c.mentions} mention${c.mentions !== 1 ? 's' : ''}`)
    .join('\n');

  const citedQueryLines = report.top_cited_queries.length > 0
    ? report.top_cited_queries
        .map((r, i) => `  ${i + 1}. "${r.query_text}" → ${r.citation_type} (pos ${r.sources[0]?.position ?? '?'})`)
        .join('\n')
    : '  None — your brand was not cited in any of the 40 tracked queries.';

  return `## Google AI Overviews Visibility Report
**Domain:** ${report.domain}
**Brand:** ${report.brand_name}
**Analyzed:** ${new Date(report.analyzed_at).toUTCString()}

---

### Citation Score: ${score.toFixed(2)}% ${grade}
Your brand was cited in **${report.total_citations}** of **${report.queries_run}** AI Overview responses.

| Metric | Value |
|---|---|
| Explicit Citations (direct domain link) | ${report.explicit_citations} |
| Implicit Citations (brand mention via 3rd party) | ${report.implicit_citations} |
| Average Citation Position | ${report.avg_citation_position !== null ? report.avg_citation_position : 'N/A'} |
| Brand Sentiment in Overviews | ${report.sentiment} |
| Missed Opportunities | ${report.missed_opportunities} queries |
| Weighted Citation Score | ${report.raw_analysis.weighted_citation_score} / ${report.raw_analysis.max_possible_weighted_score} |

### Citation Position Distribution
${posDistLines}

### Where Your Brand Was Cited
${citedQueryLines}

### Top Competing Domains in Your AI Overviews
${competitorLines || '  (none detected)'}

---
*Run a full analysis at https://wellows.com/tools/ai-overviews-tracker/*
*Upgrade for daily monitoring: https://wellows.com/pricing/*`;
}

export function registerCheckVisibilityTool(server: McpServer): void {
  server.tool(
    'check_ai_overviews_visibility',
    `Analyze a domain's full citation score and visibility within Google AI Overviews.
Crawls the domain, extracts brand entities, generates 40 intent-driven search queries,
scans live Google AI Overview responses for each query, and returns a complete scorecard:
citation score %, explicit citations (direct domain links), implicit citations (3rd-party
brand mentions), average citation position (1=best), sentiment analysis, top competing
domains, and missed opportunity count. Takes approximately 4-5 minutes to complete.
Use when a user asks about their Google AI Overviews visibility, citation score, AI search
presence, or whether their brand appears in Google's AI-generated answers.`,
    {
      domain: z.string()
        .url('Must be a valid URL')
        .describe('The domain to analyze. Include the full URL with protocol, e.g. https://www.purevpn.com'),
    },
    async ({ domain }, _extra) => {
      const steps: string[] = [];

      try {
        steps.push('Crawling domain content...');
        const scrapeData = await scrapeDomain(domain);
        steps.push(`✓ Scraped ${scrapeData.scrapingMetadata.pagesScraped} pages (${scrapeData.scrapingMetadata.totalContentLength.toLocaleString()} chars). Brand: ${scrapeData.brandName}`);

        steps.push('Extracting brand entities, pain points, and goals...');
        const entitiesData = await extractEntities(scrapeData, (status, elapsed) => {
          steps.push(`  Entity extraction: ${status} (${elapsed}s)`);
        });
        steps.push(`✓ Extracted ${entitiesData.entities.length} entities, ${entitiesData.painPoints.length} pain points, ${entitiesData.jtbds.length} JTBDs, ${entitiesData.goals.length} goals`);

        steps.push('Generating AI Overview query set...');
        const queriesData = await generateQueries(scrapeData, entitiesData, (status, elapsed) => {
          steps.push(`  Query generation: ${status} (${elapsed}s)`);
        });
        steps.push(`✓ Generated ${queriesData.queries.length} queries`);

        steps.push(`Scanning Google AI Overviews for ${queriesData.queries.length} queries (this takes ~3 min)...`);
        let lastProgress = 0;
        const serpResults = await runSerpSearches(
          queriesData.queries,
          scrapeData,
          (completed, total) => {
            if (completed - lastProgress >= 5 || completed === total) {
              steps.push(`  SERP scan: ${completed}/${total} queries processed`);
              lastProgress = completed;
            }
          }
        );
        steps.push(`✓ SERP scan complete. ${Object.keys(serpResults).length} queries returned results.`);

        const analysis = aggregateCitationAnalysis(scrapeData.domain, queriesData.queries, serpResults);
        const report = buildVisibilityReport(domain, scrapeData.brandName, analysis);
        const formatted = formatReportAsText(report);

        return {
          content: [
            {
              type: 'text' as const,
              text: `### Analysis Progress\n${steps.map(s => `- ${s}`).join('\n')}\n\n---\n\n${formatted}`,
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `### Analysis Progress\n${steps.map(s => `- ${s}`).join('\n')}\n\n---\n\n**Error:** ${message}\n\nPlease verify the domain URL is correct and try again. If the issue persists, check https://wellows.com/contact-us/`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
