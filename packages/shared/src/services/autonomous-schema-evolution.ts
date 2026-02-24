/**
 * Autonomous Schema Hot-Patching Service
 *
 * Problem Solved: Manual Alias Approval Bottleneck
 * - ParameterAliaser tracks mismatches and creates aliases
 * - But aliases still require manual approval for production use
 * - High-frequency aliases (used 100+ times) should be auto-promoted
 *
 * Solution: Automated PR Generation for Schema Evolution
 * - Track alias usage frequency
 * - When usage > threshold (default: 100), auto-generate PR to update @repo/mcp-protocol
 * - PR includes:
 *   - Schema field name updates
 *   - Zod schema modifications
 *   - Migration guide for backward compatibility
 * - Human reviews and merges PR (one-click approval)
 *
 * Architecture:
 * 1. AliasUsageTracker monitors alias usage across all tools
 * 2. When frequency threshold reached, trigger SchemaHotPatcher
 * 3. SchemaHotPatcher generates code changes
 * 4. GitHubService creates PR with detailed description
 * 5. Human reviews and merges
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from '@upstash/redis';
import { getRedisClient, ServiceNamespace } from '../redis';
import { getParameterAliaserService, type ParameterAlias } from './parameter-aliaser';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface AliasUsageRecord {
  /** Tool name */
  toolName: string;
  /** Alias field (LLM's name) */
  aliasField: string;
  /** Primary field (schema's name) */
  primaryField: string;
  /** Total usage count */
  usageCount: number;
  /** First recorded usage */
  firstUsedAt: string;
  /** Last recorded usage */
  lastUsedAt: string;
  /** Whether PR has been generated */
  prGenerated: boolean;
  /** PR number if generated */
  prNumber?: number;
  /** PR URL if generated */
  prUrl?: string;
  /** Whether PR was merged */
  prMerged: boolean;
  /** When PR was merged */
  mergedAt?: string;
}

export interface SchemaHotPatchConfig {
  redis: Redis;
  /** Usage count threshold before generating PR (default: 100) */
  usageThreshold?: number;
  /** GitHub repository owner */
  githubOwner?: string;
  /** GitHub repository name */
  githubRepo?: string;
  /** GitHub token for PR creation */
  githubToken?: string;
  /** Branch prefix for schema updates */
  branchPrefix?: string;
}

const DEFAULT_CONFIG: Required<SchemaHotPatchConfig> = {
  redis: null as any,
  usageThreshold: 100,
  githubOwner: '',
  githubRepo: '',
  githubToken: '',
  branchPrefix: 'schema-hotfix/',
};

// ============================================================================
// ALIAS USAGE TRACKER
// Monitors alias usage across all tools
// ============================================================================

export class AliasUsageTracker {
  private config: Required<SchemaHotPatchConfig>;
  private localCache: Map<string, AliasUsageRecord> = new Map();

  constructor(config: SchemaHotPatchConfig) {
    this.config = { ...DEFAULT_CONFIG, redis: config.redis };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildUsageKey(toolName: string, aliasField: string): string {
    return `alias_usage:${toolName}:${aliasField}`;
  }

  private buildPendingPRsKey(): string {
    return 'alias_usage:pending_prs';
  }

  // ========================================================================
  // USAGE TRACKING
  // ========================================================================

  /**
   * Record alias usage
   * Increments usage count and updates timestamps
   *
   * @param toolName - Tool name
   * @param aliasField - Alias field used
   * @param primaryField - Primary field
   * @returns Updated usage record
   */
  async recordUsage(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): Promise<AliasUsageRecord> {
    const usageKey = this.buildUsageKey(toolName, aliasField);
    const now = new Date().toISOString();

    // Get existing record
    const existingData = await this.config.redis.get<any>(usageKey);
    let record: AliasUsageRecord;

    if (existingData) {
      record = typeof existingData === 'string' ? JSON.parse(existingData) : existingData;
      record.usageCount++;
      record.lastUsedAt = now;
    } else {
      record = {
        toolName,
        aliasField,
        primaryField,
        usageCount: 1,
        firstUsedAt: now,
        lastUsedAt: now,
        prGenerated: false,
        prMerged: false,
      };
    }

    // Store updated record
    await this.config.redis.setex(
      usageKey,
      30 * 24 * 60 * 60, // 30 days TTL
      JSON.stringify(record)
    );

    // Update local cache
    this.localCache.set(`${toolName}:${aliasField}`, record);

    return record;
  }

  /**
   * Get usage record for an alias
   */
  async getUsage(toolName: string, aliasField: string): Promise<AliasUsageRecord | null> {
    const cacheKey = `${toolName}:${aliasField}`;
    const cached = this.localCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const usageKey = this.buildUsageKey(toolName, aliasField);
    const data = await this.config.redis.get<any>(usageKey);

    if (!data) {
      return null;
    }

    const record = typeof data === 'string' ? JSON.parse(data) : data;
    this.localCache.set(cacheKey, record);
    return record;
  }

  /**
   * Get all aliases exceeding usage threshold
   * These should have PRs generated
   */
  async getExceedingAliases(threshold?: number): Promise<AliasUsageRecord[]> {
    const thresholdToUse = threshold ?? this.config.usageThreshold;
    const pattern = 'alias_usage:*';
    const keys = await this.config.redis.keys(pattern);

    const exceeding: AliasUsageRecord[] = [];

    for (const key of keys) {
      const data = await this.config.redis.get<any>(key);
      if (!data) continue;

      const record = typeof data === 'string' ? JSON.parse(data) : data;

      if (record.usageCount >= thresholdToUse && !record.prGenerated) {
        exceeding.push(record);
      }
    }

    return exceeding;
  }

  /**
   * Mark PR as generated for an alias
   */
  async markPRGenerated(
    toolName: string,
    aliasField: string,
    prNumber: number,
    prUrl: string
  ): Promise<void> {
    const usageKey = this.buildUsageKey(toolName, aliasField);
    const record = await this.getUsage(toolName, aliasField);

    if (!record) {
      throw new Error(`Usage record not found for ${toolName}:${aliasField}`);
    }

    record.prGenerated = true;
    record.prNumber = prNumber;
    record.prUrl = prUrl;

    await this.config.redis.setex(
      usageKey,
      30 * 24 * 60 * 60,
      JSON.stringify(record)
    );

    // Add to pending PRs set
    await this.config.redis.sadd(
      this.buildPendingPRsKey(),
      `${toolName}:${aliasField}`
    );

    this.localCache.set(`${toolName}:${aliasField}`, record);
  }

  /**
   * Mark PR as merged for an alias
   */
  async markPRMerged(toolName: string, aliasField: string): Promise<void> {
    const usageKey = this.buildUsageKey(toolName, aliasField);
    const record = await this.getUsage(toolName, aliasField);

    if (!record) {
      throw new Error(`Usage record not found for ${toolName}:${aliasField}`);
    }

    record.prMerged = true;
    record.mergedAt = new Date().toISOString();

    await this.config.redis.setex(
      usageKey,
      30 * 24 * 60 * 60,
      JSON.stringify(record)
    );

    // Remove from pending PRs
    await this.config.redis.srem(
      this.buildPendingPRsKey(),
      `${toolName}:${aliasField}`
    );

    this.localCache.set(`${toolName}:${aliasField}`, record);
  }

  /**
   * Get pending PRs
   */
  async getPendingPRs(): Promise<AliasUsageRecord[]> {
    const pendingKeys = await this.config.redis.smembers(this.buildPendingPRsKey());
    const records: AliasUsageRecord[] = [];

    for (const key of pendingKeys) {
      const [toolName, aliasField] = key.split(':');
      const record = await this.getUsage(toolName, aliasField);
      if (record && record.prGenerated && !record.prMerged) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Get usage statistics
   */
  async getStats(): Promise<{
    totalTrackedAliases: number;
    exceedingThreshold: number;
    prsGenerated: number;
    prsMerged: number;
    topAliases: Array<{
      toolName: string;
      aliasField: string;
      usageCount: number;
    }>;
  }> {
    const pattern = 'alias_usage:*';
    const keys = await this.config.redis.keys(pattern);

    let totalTrackedAliases = 0;
    let exceedingThreshold = 0;
    let prsGenerated = 0;
    let prsMerged = 0;
    const allAliases: Array<{
      toolName: string;
      aliasField: string;
      usageCount: number;
    }> = [];

    for (const key of keys) {
      const data = await this.config.redis.get<any>(key);
      if (!data) continue;

      const record = typeof data === 'string' ? JSON.parse(data) : data;
      totalTrackedAliases++;

      if (record.usageCount >= this.config.usageThreshold) {
        exceedingThreshold++;
      }
      if (record.prGenerated) {
        prsGenerated++;
      }
      if (record.prMerged) {
        prsMerged++;
      }

      const [toolName, aliasField] = key.replace('alias_usage:', '').split(':');
      allAliases.push({ toolName, aliasField, usageCount: record.usageCount });
    }

    // Sort by usage count
    allAliases.sort((a, b) => b.usageCount - a.usageCount);

    return {
      totalTrackedAliases,
      exceedingThreshold,
      prsGenerated,
      prsMerged,
      topAliases: allAliases.slice(0, 20),
    };
  }
}

// ============================================================================
// SCHEMA HOT PATCHER
// Generates code changes and PRs for schema evolution
// ============================================================================

export class SchemaHotPatcher {
  private config: Required<SchemaHotPatchConfig>;
  private usageTracker: AliasUsageTracker;

  constructor(config: SchemaHotPatchConfig, usageTracker: AliasUsageTracker) {
    this.config = { ...DEFAULT_CONFIG, redis: config.redis };
    this.usageTracker = usageTracker;
  }

  /**
   * Generate a hot patch PR for an alias
   *
   * Creates a PR that:
   * 1. Updates Zod schema field names
   * 2. Adds backward compatibility layer
   * 3. Updates MCP protocol definitions
   *
   * @param record - Alias usage record
   * @returns PR details
   */
  async generateHotPatchPR(record: AliasUsageRecord): Promise<{
    prNumber: number;
    prUrl: string;
    branchName: string;
    filesChanged: string[];
  }> {
    const { toolName, aliasField, primaryField } = record;

    console.log(
      `[SchemaHotPatcher] Generating PR for ${toolName}: ${aliasField} -> ${primaryField}`
    );

    // Generate branch name
    const branchName = `${this.config.branchPrefix}${toolName}-${aliasField}-to-${primaryField}`;

    // Generate file changes
    const filesChanged = await this.generateFileChanges(toolName, aliasField, primaryField);

    // Create PR via GitHub API
    const prDetails = await this.createGitHubPR({
      branchName,
      title: `Schema Evolution: ${aliasField} → ${primaryField} in ${toolName}`,
      body: this.generatePRBody(record),
      filesChanged,
    });

    // Mark PR as generated
    await this.usageTracker.markPRGenerated(
      toolName,
      aliasField,
      prDetails.number,
      prDetails.url
    );

    console.log(
      `[SchemaHotPatcher] Created PR #${prDetails.number}: ${prDetails.url}`
    );

    return {
      prNumber: prDetails.number,
      prUrl: prDetails.url,
      branchName,
      filesChanged: filesChanged.map(f => f.path),
    };
  }

  /**
   * Generate file changes for schema evolution
   */
  private async generateFileChanges(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = [];

    // 1. Update Zod schema in @repo/mcp-protocol
    const schemaPath = `packages/mcp-protocol/src/schemas/${toolName}.ts`;
    const schemaContent = this.generateSchemaUpdate(toolName, aliasField, primaryField);
    files.push({ path: schemaPath, content: schemaContent });

    // 2. Update tool definition
    const toolDefPath = `packages/mcp-protocol/src/tools/${toolName}.ts`;
    const toolDefContent = this.generateToolDefinitionUpdate(toolName, aliasField, primaryField);
    files.push({ path: toolDefPath, content: toolDefContent });

    // 3. Add backward compatibility layer
    const compatPath = `packages/mcp-protocol/src/compat/${toolName}-alias.ts`;
    const compatContent = this.generateCompatibilityLayer(toolName, aliasField, primaryField);
    files.push({ path: compatPath, content: compatContent });

    // 4. Update migration guide (note: append logic would be handled by GitHub API)
    const migrationPath = `packages/mcp-protocol/MIGRATION.md`;
    const migrationContent = this.generateMigrationGuideEntry(toolName, aliasField, primaryField);
    files.push({ path: migrationPath, content: migrationContent });

    return files;
  }

  /**
   * Generate Zod schema update
   */
  private generateSchemaUpdate(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): string {
    return `/**
 * Auto-generated schema update by SchemaHotPatcher
 * Alias: ${aliasField} -> ${primaryField}
 * Usage count: Exceeded threshold (${this.config.usageThreshold})
 *
 * This update renames the field to match common LLM usage patterns.
 * Backward compatibility is maintained via the alias layer.
 */

import { z } from 'zod';

// Updated schema with primary field name
export const ${toolName}Schema = z.object({
  // ... other fields
  ${primaryField}: z.string().describe('Primary field (formerly ${aliasField})'),
  // ... other fields
});

// Backward compatibility: accept both field names
export const ${toolName}SchemaWithAlias = z.object({
  // ... other fields
  ${primaryField}: z.string().describe('Primary field'),
  ${aliasField}: z.string().optional().describe('Deprecated: use ${primaryField}'),
  // ... other fields
}).transform((data) => {
  // Migrate alias to primary field
  if (data.${aliasField} && !data.${primaryField}) {
    data.${primaryField} = data.${aliasField};
  }
  delete data.${aliasField};
  return data;
});
`;
  }

  /**
   * Generate tool definition update
   */
  private generateToolDefinitionUpdate(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): string {
    return `/**
 * Auto-generated tool definition update by SchemaHotPatcher
 * Alias: ${aliasField} -> ${primaryField}
 */

import { ${toolName}Schema } from '../schemas/${toolName}';

export const ${toolName}Tool = {
  name: '${toolName}',
  description: 'Tool with updated schema',
  inputSchema: ${toolName}Schema,
  // Parameter metadata updated
  parameters: {
    // ... other parameters
    ${primaryField}: {
      type: 'string',
      description: 'Primary field (formerly ${aliasField})',
      required: true,
    },
    // ... other parameters
  },
};
`;
  }

  /**
   * Generate backward compatibility layer
   */
  private generateCompatibilityLayer(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): string {
    return `/**
 * Backward Compatibility Layer for ${toolName}
 * Auto-generated by SchemaHotPatcher
 *
 * Accepts both old (${aliasField}) and new (${primaryField}) field names.
 * Automatically migrates old field names to new ones.
 */

import { ${toolName}Schema } from '../schemas/${toolName}';

export function migrate${toolName.charAt(0).toUpperCase() + toolName.slice(1)}Parameters(
  params: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...params };

  // Migrate alias to primary field
  if (result.${aliasField} !== undefined && result.${primaryField} === undefined) {
    console.log(
      \`[Compatibility] Migrating ${aliasField} -> ${primaryField} in ${toolName}\`
    );
    result.${primaryField} = result.${aliasField};
    delete result.${aliasField};
  }

  return result;
}

// Deprecated field mapping for observability
export const DEPRECATED_FIELDS = {
  ${aliasField}: '${primaryField}',
};
`;
  }

  /**
   * Generate migration guide entry
   */
  private generateMigrationGuideEntry(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): string {
    const date = new Date().toISOString().split('T')[0];

    return `
## ${date} - ${toolName}: ${aliasField} → ${primaryField}

### Summary
Field \`${aliasField}\` has been renamed to \`${primaryField}\` to align with common LLM usage patterns.

### Backward Compatibility
- Old field name \`${aliasField}\` is still accepted but deprecated
- Automatic migration layer converts old field names to new ones
- Deprecation warnings logged for observability

### Migration Steps
1. Update any hardcoded references from \`${aliasField}\` to \`${primaryField}\`
2. Update LLM prompts to use \`${primaryField}\`
3. Remove compatibility layer after 30 days (optional)

### Rationale
This change was auto-generated after the alias was used ${this.config.usageThreshold}+ times, indicating a systematic mismatch between schema naming and LLM output patterns.

---
`;
  }

  /**
   * Generate PR body
   */
  private generatePRBody(record: AliasUsageRecord): string {
    return `## Schema Evolution: Auto-Generated Hot Patch

### Changes
This PR updates the schema field name to match common LLM usage patterns.

- **Tool**: ${record.toolName}
- **Field Change**: \`${record.aliasField}\` → \`${record.primaryField}\`
- **Usage Count**: ${record.usageCount} (threshold: ${this.config.usageThreshold})

### Rationale
This change was auto-generated by the **SchemaHotPatcher** service after detecting that the alias was used repeatedly (${record.usageCount} times), indicating a systematic mismatch between the schema naming convention and LLM output patterns.

### Files Changed
1. \`packages/mcp-protocol/src/schemas/${record.toolName}.ts\` - Updated Zod schema
2. \`packages/mcp-protocol/src/tools/${record.toolName}.ts\` - Updated tool definition
3. \`packages/mcp-protocol/src/compat/${record.toolName}-alias.ts\` - Backward compatibility layer
4. \`packages/mcp-protocol/MIGRATION.md\` - Migration guide

### Backward Compatibility
✅ Old field name is still accepted via compatibility layer
✅ Automatic migration converts old field names to new ones
✅ Deprecation warnings logged for observability

### Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] LLM output validation passes
- [ ] Backward compatibility verified

### Checklist
- [ ] Review automated changes
- [ ] Verify field rename doesn't break existing integrations
- [ ] Approve and merge
- [ ] Monitor deprecation logs after merge

---
*This PR was auto-generated by SchemaHotPatcher. For questions, contact the platform team.*
`;
  }

  /**
   * Create GitHub PR
   */
  private async createGitHubPR(details: {
    branchName: string;
    title: string;
    body: string;
    filesChanged: Array<{ path: string; content: string; append?: boolean }>;
  }): Promise<{ number: number; url: string }> {
    const { githubOwner, githubRepo, githubToken } = this.config;

    if (!githubOwner || !githubRepo || !githubToken) {
      throw new Error(
        'GitHub credentials not configured. Set GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN.'
      );
    }

    // Note: In a real implementation, you would:
    // 1. Create a new branch
    // 2. Commit file changes
    // 3. Push to GitHub
    // 4. Create PR via GitHub API

    // For now, return a mock PR
    console.warn(
      `[SchemaHotPatcher] GitHub PR creation not fully implemented. ` +
      `Would create PR: ${details.title}`
    );

    return {
      number: 0,
      url: `https://github.com/${githubOwner}/${githubRepo}/compare/${details.branchName}?expand=1`,
    };
  }
}

// ============================================================================
// AUTONOMOUS SCHEMA EVOLUTION SERVICE
// Combines usage tracking + hot patching
// ============================================================================

export class AutonomousSchemaEvolutionService {
  private usageTracker: AliasUsageTracker;
  private hotPatcher: SchemaHotPatcher;
  private config: Required<SchemaHotPatchConfig>;

  constructor(config: SchemaHotPatchConfig) {
    this.config = { ...DEFAULT_CONFIG, redis: config.redis };
    this.usageTracker = new AliasUsageTracker(config);
    this.hotPatcher = new SchemaHotPatcher(config, this.usageTracker);
  }

  /**
   * Record alias usage and check if PR should be generated
   */
  async recordAliasUsage(
    toolName: string,
    aliasField: string,
    primaryField: string
  ): Promise<{ shouldGeneratePR: boolean; record?: AliasUsageRecord }> {
    const record = await this.usageTracker.recordUsage(toolName, aliasField, primaryField);

    if (record.usageCount >= this.config.usageThreshold && !record.prGenerated) {
      // Generate PR automatically
      await this.hotPatcher.generateHotPatchPR(record);
      return { shouldGeneratePR: true, record };
    }

    return { shouldGeneratePR: false, record };
  }

  /**
   * Manually trigger PR generation for an alias
   */
  async generatePR(toolName: string, aliasField: string): Promise<{
    prNumber: number;
    prUrl: string;
    branchName: string;
  }> {
    const record = await this.usageTracker.getUsage(toolName, aliasField);

    if (!record) {
      throw new Error(`No usage record found for ${toolName}:${aliasField}`);
    }

    return this.hotPatcher.generateHotPatchPR(record);
  }

  /**
   * Get pending PRs
   */
  async getPendingPRs(): Promise<AliasUsageRecord[]> {
    return this.usageTracker.getPendingPRs();
  }

  /**
   * Mark PR as merged
   */
  async markPRMerged(toolName: string, aliasField: string): Promise<void> {
    return this.usageTracker.markPRMerged(toolName, aliasField);
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalTrackedAliases: number;
    exceedingThreshold: number;
    prsGenerated: number;
    prsMerged: number;
    topAliases: Array<{
      toolName: string;
      aliasField: string;
      usageCount: number;
    }>;
  }> {
    return this.usageTracker.getStats();
  }

  /**
   * Get the usage tracker
   */
  getUsageTracker(): AliasUsageTracker {
    return this.usageTracker;
  }

  /**
   * Get the hot patcher
   */
  getHotPatcher(): SchemaHotPatcher {
    return this.hotPatcher;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultAutonomousSchemaEvolution: AutonomousSchemaEvolutionService | null = null;

export function getAutonomousSchemaEvolutionService(
  config?: SchemaHotPatchConfig
): AutonomousSchemaEvolutionService {
  if (!defaultAutonomousSchemaEvolution) {
    const redis = config?.redis || getRedisClient(ServiceNamespace.SHARED);
    defaultAutonomousSchemaEvolution = new AutonomousSchemaEvolutionService({
      redis,
      ...config,
    });
  }
  return defaultAutonomousSchemaEvolution;
}

export function createAutonomousSchemaEvolutionService(
  config?: SchemaHotPatchConfig
): AutonomousSchemaEvolutionService {
  const redis = config?.redis || getRedisClient(ServiceNamespace.SHARED);
  return new AutonomousSchemaEvolutionService({ redis, ...config });
}
