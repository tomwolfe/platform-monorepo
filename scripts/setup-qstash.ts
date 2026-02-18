#!/usr/bin/env tsx
/**
 * QStash Setup Script
 * 
 * This script helps you configure Upstash QStash for reliable saga execution.
 * 
 * Prerequisites:
 * 1. Create a free Upstash account at https://console.upstash.io
 * 2. Create a QStash database (free tier: 10k requests/day)
 * 
 * Usage:
 *   pnpm tsx scripts/setup-qstash.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const ENV_FILE = path.join(__dirname, '..', '.env');

console.log('🔧 QStash Setup for Vercel Hobby Tier\n');
console.log('This script will help you configure Upstash QStash for reliable saga execution.\n');

// Step 1: Check if .env exists
if (!fs.existsSync(ENV_FILE)) {
  console.error('❌ .env file not found!');
  console.log(`Expected at: ${ENV_FILE}`);
  process.exit(1);
}

// Step 2: Read current .env
let envContent = fs.readFileSync(ENV_FILE, 'utf-8');

// Step 3: Check for existing QStash configuration
const hasQstashToken = envContent.includes('QSTASH_TOKEN=') && !envContent.match(/QSTASH_TOKEN=""\s*$/m);
const hasSigningKeys = envContent.includes('QSTASH_CURRENT_SIGNING_KEY=') && !envContent.match(/QSTASH_CURRENT_SIGNING_KEY=""\s*$/m);

if (hasQstashToken && hasSigningKeys) {
  console.log('✅ QStash appears to be configured in your .env file!\n');
  console.log('Next steps:');
  console.log('1. Restart your development server to load the new environment variables');
  console.log('2. Test the execution flow with a multi-step intent');
  console.log('3. Deploy to Vercel and monitor execution logs\n');
  process.exit(0);
}

// Step 4: Provide setup instructions
console.log('📋 Setup Instructions:\n');
console.log('1. Go to https://console.upstash.io and log in (or create account)');
console.log('2. Click "Create Database" or go to QStash section');
console.log('3. Create a new QStash database (free tier is sufficient)\n');

console.log('4. Copy the following values from QStash Console:\n');

console.log('   ┌─────────────────────────────────────────────────────────────┐');
console.log('   │ From QStash Console > Overview:                             │');
console.log('   │   - REST URL:     https://qstash-us-east-1.upstash.io       │');
console.log('   │   - Token:        [Click to reveal and copy]                │');
console.log('   │                                                             │');
console.log('   │ From QStash Console > Keys (for webhook verification):      │');
console.log('   │   - Current Signing Key: [base64 encoded key]               │');
console.log('   │   - Next Signing Key:  [base64 encoded key]                 │');
console.log('   └─────────────────────────────────────────────────────────────┘\n');

console.log('5. Update your .env file at: ' + ENV_FILE);
console.log('   Replace the empty values:\n');

console.log('   QSTASH_TOKEN="your_token_here"');
console.log('   QSTASH_CURRENT_SIGNING_KEY="your_current_signing_key_here"');
console.log('   QSTASH_NEXT_SIGNING_KEY="your_next_signing_key_here"\n');

console.log('📝 Alternatively, you can manually edit the .env file.\n');

// Step 5: Offer to update .env interactively
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Would you like to enter the values now? (y/n)');

readline.question('> ', (answer: string) => {
  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    console.log('\nEnter your QSTASH_TOKEN:');
    readline.question('> ', (token: string) => {
      console.log('Enter your QSTASH_CURRENT_SIGNING_KEY:');
      readline.question('> ', (currentKey: string) => {
        console.log('Enter your QSTASH_NEXT_SIGNING_KEY (or press Enter to skip):');
        readline.question('> ', (nextKey: string) => {
          // Update .env file
          envContent = envContent.replace(
            /QSTASH_TOKEN=""\s*/m,
            `QSTASH_TOKEN="${token}"\n`
          );
          envContent = envContent.replace(
            /QSTASH_CURRENT_SIGNING_KEY=""\s*/m,
            `QSTASH_CURRENT_SIGNING_KEY="${currentKey}"\n`
          );
          if (nextKey) {
            envContent = envContent.replace(
              /QSTASH_NEXT_SIGNING_KEY=""\s*/m,
              `QSTASH_NEXT_SIGNING_KEY="${nextKey}"\n`
            );
          }

          fs.writeFileSync(ENV_FILE, envContent);
          console.log('\n✅ .env file updated successfully!\n');
          console.log('Next steps:');
          console.log('1. Restart your development server');
          console.log('2. Test with: curl -X POST http://localhost:3000/api/engine/execute-step \\');
          console.log('     -H "Content-Type: application/json" \\');
          console.log('     -d \'{"executionId": "test-uuid"}\'');
          console.log('3. Check logs for "[QStashService] Initialized" message\n');
          
          readline.close();
        });
      });
    });
  } else {
    console.log('\nNo problem! You can manually update the .env file later.');
    console.log('After updating, restart your development server.\n');
    readline.close();
  }
});
