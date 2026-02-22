/**
 * Generate schema migration from proposal
 * Used by GitHub Actions workflow
 */

import { createSchemaEvolutionService } from '../packages/shared/src/services/schema-evolution';
import { createMigrationGeneratorService } from '../packages/shared/src/services/migration-generator';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

async function generateMigration() {
  const proposalId = process.env.PROPOSAL_ID;
  
  if (!proposalId) {
    console.error('PROPOSAL_ID environment variable is required');
    process.exit(1);
  }
  
  try {
    // Initialize services
    const schemaEvolution = createSchemaEvolutionService();
    const migrationGenerator = createMigrationGeneratorService();
    
    // Get proposal
    const proposal = await schemaEvolution.getProposal(proposalId);
    
    if (!proposal) {
      console.error(`Proposal ${proposalId} not found`);
      console.log('success=false');
      process.exit(1);
    }
    
    if (proposal.status !== 'pending') {
      console.log(`Proposal ${proposalId} is already ${proposal.status}, skipping`);
      console.log('success=false');
      process.exit(0);
    }
    
    console.log(`Generating migration for proposal ${proposalId}...`);
    console.log(`Intent: ${proposal.intentType}, Tool: ${proposal.toolName}`);
    console.log(`Proposed fields: ${proposal.proposedFields.length}`);
    
    // Generate migration
    const result = await migrationGenerator.generateMigration(proposal);
    
    if (!result.success || !result.migration) {
      console.error('Migration generation failed:', result.error);
      console.log('success=false');
      process.exit(1);
    }
    
    console.log('Migration generated successfully!');
    console.log(`File: ${result.migration.fileName}`);
    console.log(`Table: ${result.migration.tableName}`);
    console.log(`Type: ${result.migration.migrationType}`);
    
    if (result.warnings.length > 0) {
      console.log('Warnings:');
      result.warnings.forEach(w => console.log(`  - ${w}`));
    }
    
    console.log('\nSQL Preview:');
    console.log(result.sqlPreview);
    
    // Write migration file
    const drizzleDir = join(process.cwd(), 'packages', 'database', 'drizzle');
    
    if (!existsSync(drizzleDir)) {
      mkdirSync(drizzleDir, { recursive: true });
    }
    
    const migrationPath = join(drizzleDir, result.migration.fileName);
    writeFileSync(migrationPath, result.migration.content, 'utf-8');
    
    console.log(`\nMigration file written to: ${migrationPath}`);
    
    // Write rollback file
    if (result.migration.rollbackContent) {
      const rollbackFileName = result.migration.fileName.replace('.ts', '.rollback.ts');
      const rollbackPath = join(drizzleDir, rollbackFileName);
      writeFileSync(rollbackPath, result.migration.rollbackContent, 'utf-8');
      console.log(`Rollback file written to: ${rollbackPath}`);
    }
    
    // Write proposal metadata
    const metadataPath = join(drizzleDir, `${result.migration.fileName}.meta.json`);
    writeFileSync(
      metadataPath,
      JSON.stringify({
        proposalId: proposal.id,
        intentType: proposal.intentType,
        toolName: proposal.toolName,
        reason: proposal.reason,
        generatedAt: new Date().toISOString(),
        affectedColumns: result.affectedColumns,
        isConcurrentSafe: result.migration.isConcurrentSafe,
        estimatedDurationMs: result.migration.estimatedDurationMs,
      }, null, 2),
      'utf-8'
    );
    console.log(`Metadata written to: ${metadataPath}`);
    
    // Output for GitHub Actions
    console.log('success=true');
    console.log(`migration_file=${result.migration.fileName}`);
    console.log(`table_name=${result.migration.tableName}`);
    
    if (process.env.GITHUB_OUTPUT) {
      const fs = require('fs');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `success=true\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `migration_file=${result.migration.fileName}\n`);
    }
    
  } catch (error) {
    console.error('Error generating migration:', error);
    console.log('success=false');
    process.exit(1);
  }
}

generateMigration();
