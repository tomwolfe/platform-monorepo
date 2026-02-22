/**
 * Check for pending schema evolution proposals
 * Used by GitHub Actions workflow
 */

import { createSchemaEvolutionService } from '../packages/shared/src/services/schema-evolution';

async function checkProposals() {
  try {
    const specificProposalId = process.env.PROPOSAL_ID;
    
    // Initialize schema evolution service
    const schemaEvolution = createSchemaEvolutionService();
    
    let proposals;
    
    if (specificProposalId) {
      // Check specific proposal
      const proposal = await schemaEvolution.getProposal(specificProposalId);
      proposals = proposal ? [proposal] : [];
    } else {
      // Get all pending proposals
      proposals = await schemaEvolution.getProposals(undefined, undefined, 'pending', 10);
    }
    
    if (proposals.length === 0) {
      console.log('No pending proposals found');
      console.log('has_proposals=false');
      console.log('proposal_ids=[]');
      process.exit(0);
    }
    
    console.log(`Found ${proposals.length} pending proposal(s)`);
    
    // Output for GitHub Actions
    const proposalIds = proposals.map(p => p.id);
    
    console.log(`has_proposals=true`);
    console.log(`proposal_ids=${JSON.stringify(proposalIds)}`);
    
    // Set GitHub Actions output
    if (process.env.GITHUB_OUTPUT) {
      const fs = require('fs');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_proposals=true\n`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `proposal_ids=${JSON.stringify(proposalIds)}\n`);
    }
    
  } catch (error) {
    console.error('Error checking proposals:', error);
    process.exit(1);
  }
}

checkProposals();
