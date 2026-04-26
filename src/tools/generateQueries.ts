import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { scrapeDomain, extractEntities, generateQueries } from '../client/wellowsClient.js';
import type { GeneratedQuery } from '../types/index.js';

export function registerGenerateQueriesTool(server: McpServer): void {
  server.tool(
    'generate_ai_overview_queries',
    `Generate high-intent search queries for a domain that are designed to trigger
Google AI Overviews. Analyzes the domain to understand its topics, then produces
up to 40 queries based on pain points, entities, jobs-to-be-done, and business goals.
Each query is tagged with intent type (Informational/Transactional) and source type.
Takes approximately 60-90 seconds. Use for content strategy, finding AI Overview
opportunities, query gap analysis, or understanding how target audiences search.`,
    {
      domain: z.string()
        .url('Must be a valid URL')
        .describe('The domain to generate queries for, e.g. https://www.example.com'),
    },
    async ({ domain }) => {
      try {
        const scrapeData = await scrapeDomain(domain);
        const entitiesData = await extractEntities(scrapeData);
        const queriesData = await generateQueries(scrapeData, entitiesData);

        const grouped = queriesData.queries.reduce(
          (acc, q) => {
            if (!acc[q.source_type]) acc[q.source_type] = [];
            acc[q.source_type].push(q);
            return acc;
          },
          {} as Record<string, GeneratedQuery[]>
        );

        const sourceTypeLabel: Record<string, string> = {
          pain_point: 'Pain Point Queries',
          entity: 'Entity/Product Queries',
          jtbd: 'Job-to-Be-Done Queries',
          goal: 'Goal-Oriented Queries',
        };

        const groupedOutput = Object.entries(grouped)
          .map(([type, qs]) => {
            const label = sourceTypeLabel[type] ?? type;
            const queryList = qs.map((q, i) => `  ${i + 1}. [${q.intent}] ${q.text}`).join('\n');
            return `### ${label} (${qs.length})\n${queryList}`;
          })
          .join('\n\n');

        const fullList = queriesData.queries
          .map((q, i) => `${i + 1}. ${q.text}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `## AI Overview Query Set: ${scrapeData.brandName} (${scrapeData.domain})
**Total queries generated:** ${queriesData.queries.length}

${groupedOutput}

---

### Full Query List (for copy-paste)
${fullList}`,
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error generating queries: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
