import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  scrapeDomain, extractEntities, generateQueries,
  runAIOSearches, aggregateCitationAnalysis
} from '../client/wellowsClient.js';
import type { VisibilityReport, CitationAnalysis } from '../types/index.js';

function buildVisibilityReport(
  _domainUrl: string,
  brandName: string,
  analysis: CitationAnalysis
): VisibilityReport {
  const citedResults = analysis.results.filter(r => r.found_citation);
  const avgPosition = citedResults.length > 0
    ? citedResults.flatMap(r => r.sources.map(s => s.position))
        .reduce((sum, p) => sum + p, 0) / citedResults.flatMap(r => r.sources).length
    : null;

  const triggeredResults = analysis.results.filter(r => r.aio_triggered);
  const avgSourcesPerAIO = triggeredResults.length > 0
    ? triggeredResults.reduce((sum, r) => sum + r.aio_source_count, 0) / triggeredResults.length
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
    aio_triggered_count: analysis.aio_triggered_count,
    aio_trigger_rate_pct: Math.round(analysis.aio_trigger_rate * 10000) / 100,
    avg_citation_position: avgPosition !== null ? Math.round(avgPosition * 10) / 10 : null,
    avg_sources_per_aio: avgSourcesPerAIO !== null ? Math.round(avgSourcesPerAIO * 10) / 10 : null,
    position_distribution: analysis.position_distribution,
    sentiment: analysis.average_sentiment,
    top_competitor_domains: topCompetitors,
    top_cited_queries: citedResults.slice(0, 5),
    serp_citations: analysis.serp_citations,
    missed_opportunities: analysis.aio_triggered_count - analysis.total_citations,
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
    ? report.top_cited_queries.map((r, i) => {
        const sourceList = r.aio_sources.slice(0, 5)
          .map(s => `    ${s.position}. ${s.url}`)
          .join('\n');
        const more = r.aio_source_count > 5 ? `\n    … +${r.aio_source_count - 5} more` : '';
        return `  ${i + 1}. "${r.query_text}" → ${r.citation_type} (${r.aio_source_count} URLs cited)\n${sourceList}${more}`;
      }).join('\n')
    : '  None — brand not cited in any of the tracked queries.';

  // SERP fallback section — queries where AIO didn't trigger
  const allResults = report.raw_analysis.results;
  const serpFallbackResults = allResults.filter(r => !r.aio_triggered && r.serp_sources.length > 0);
  const serpFallbackLines = serpFallbackResults.length > 0
    ? serpFallbackResults.slice(0, 5).map((r, i) => {
        const urlList = r.serp_sources.slice(0, 5)
          .map(s => `    ${s.position}. ${s.url}${r.domain_in_serp && s.domain === (report.domain.replace(/^www\./, '')) ? ' ← YOUR DOMAIN' : ''}`)
          .join('\n');
        const more = r.serp_sources.length > 5 ? `\n    … +${r.serp_sources.length - 5} more` : '';
        return `  ${i + 1}. "${r.query_text}"${r.domain_in_serp ? ` [your domain at #${r.serp_rank}]` : ''}\n${urlList}${more}`;
      }).join('\n')
    : '  No SERP data available for queries without AI Overview.';

  // Per-query AIO breakdown
  const notTriggered = allResults.filter(r => !r.aio_triggered).length;
  const triggeredNoCitation = allResults.filter(r => r.aio_triggered && r.citation_type === 'none').length;
  const triggeredWithCitation = allResults.filter(r => r.aio_triggered && r.citation_type !== 'none').length;

  return `## Google AI Overviews Visibility Report
**Domain:** ${report.domain}
**Brand:** ${report.brand_name}
**Analyzed:** ${new Date(report.analyzed_at).toUTCString()}

---

### Citation Score: ${score.toFixed(2)}% ${grade}
Your brand was cited in **${report.total_citations}** of **${report.queries_run}** queries.

| Metric | Value |
|---|---|
| AI Overview Triggered | ${report.aio_triggered_count} / ${report.queries_run} queries (${report.aio_trigger_rate_pct}%) |
| AI Overview NOT Triggered | ${notTriggered} queries |
| AIO Triggered — Brand Cited | ${triggeredWithCitation} queries |
| AIO Triggered — Brand Missing | ${triggeredNoCitation} queries (missed opportunities) |
| SERP Fallback — Brand in Organic Top 10 | ${report.serp_citations} queries (no AIO shown) |
| Explicit Citations (direct URL in AIO) | ${report.explicit_citations} |
| Implicit Citations (brand in AIO text) | ${report.implicit_citations} |
| Average Citation Position | ${report.avg_citation_position !== null ? report.avg_citation_position : 'N/A'} |
| Avg URLs Cited per AIO | ${report.avg_sources_per_aio !== null ? report.avg_sources_per_aio : 'N/A'} |
| Brand Sentiment in Overviews | ${report.sentiment} |
| Weighted Citation Score | ${report.raw_analysis.weighted_citation_score} / ${report.raw_analysis.max_possible_weighted_score} |

### Citation Position Distribution
${posDistLines}

### Where Your Brand Was Cited (with cited URLs)
${citedQueryLines}

### SERP Results for Queries Without AI Overview (sample)
${serpFallbackLines}

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
then uses DataForSEO to scan live Google AI Overview responses for each query.
Returns: whether AI Overview was triggered per query, all cited URLs per query,
explicit citations (direct domain link), implicit citations (brand mentioned in AIO text
by a third-party source), citation score %, average position, avg URLs cited per AIO,
top competing domains, and missed opportunity count. Takes approximately 4-5 minutes.`,
    {
      domain: z.string()
        .url('Must be a valid URL')
        .describe('The domain to analyze. Include full URL with protocol, e.g. https://www.purevpn.com'),
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

        steps.push(`Scanning Google AI Overviews via DataForSEO for ${queriesData.queries.length} queries (pass 1 + auto-retry for non-triggered queries)...`);
        let lastProgress = 0;
        const aioResults = await runAIOSearches(
          queriesData.queries,
          scrapeData,
          (completed, total) => {
            if (completed - lastProgress >= 5 || completed === total) {
              steps.push(`  AIO scan: ${completed}/${total} queries processed`);
              lastProgress = completed;
            }
          }
        );

        const triggeredCount = Object.values(aioResults).filter(r => r.aio_triggered).length;
        steps.push(`✓ AIO scan complete. ${triggeredCount}/${queriesData.queries.length} queries triggered AI Overview.`);

        const analysis = aggregateCitationAnalysis(scrapeData.domain, queriesData.queries, aioResults);
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
