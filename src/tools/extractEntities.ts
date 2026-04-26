import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { scrapeDomain, extractEntities } from '../client/wellowsClient.js';

export function registerExtractEntitiesTool(server: McpServer): void {
  server.tool(
    'extract_domain_entities',
    `Crawl a domain and extract its core brand entities, customer pain points,
jobs-to-be-done (JTBDs), and business goals using AI analysis. Faster than a full
citation scan (~30-60 seconds). Returns structured data about what topics, products,
and problems the domain addresses. Use this when a user wants to understand what their
website covers, before a full AI Overviews analysis, or for content strategy planning.`,
    {
      domain: z.string()
        .url('Must be a valid URL')
        .describe('The domain to analyze, e.g. https://www.example.com'),
    },
    async ({ domain }) => {
      try {
        const scrapeData = await scrapeDomain(domain);
        const entitiesData = await extractEntities(scrapeData);

        const entityList = entitiesData.entities
          .map(e => `- **${e.name}** (${e.category}): ${e.description}\n  Tags: ${e.tags.join(', ')}`)
          .join('\n');

        const painPointList = entitiesData.painPoints
          .map(p => `- **${p.title}** [${p.impact} Impact]: ${p.explanation}`)
          .join('\n');

        const jtbdList = entitiesData.jtbds
          .map(j => `- ${j.full_statement}`)
          .join('\n');

        const goalList = entitiesData.goals
          .map(g => `- **${g.title}** (${g.category}): ${g.description}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `## Brand Entity Analysis: ${scrapeData.brandName} (${scrapeData.domain})

### Entities (${entitiesData.entities.length})
${entityList}

### Customer Pain Points (${entitiesData.painPoints.length})
${painPointList}

### Jobs to Be Done (${entitiesData.jtbds.length})
${jtbdList}

### Business Goals (${entitiesData.goals.length})
${goalList}

---
*Pages scraped: ${scrapeData.scrapingMetadata.pagesScraped} | Content analyzed: ${scrapeData.scrapingMetadata.totalContentLength.toLocaleString()} chars*`,
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error extracting entities: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
