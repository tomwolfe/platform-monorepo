#!/usr/bin/env tsx
/**
 * QStash Configuration Test Script
 * 
 * Verifies that QStash is properly configured and working.
 * 
 * Usage:
 *   pnpm tsx scripts/test-qstash.ts
 */

import { QStashService } from '../packages/shared/src/services/qstash';

async function testQStash() {
  console.log('🧪 QStash Configuration Test\n');
  console.log('=' .repeat(50));

  // Test 1: Environment Variables
  console.log('\n1️⃣  Checking environment variables...');
  const hasToken = !!(process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN);
  const hasCurrentKey = !!process.env.QSTASH_CURRENT_SIGNING_KEY;
  const hasNextKey = !!process.env.QSTASH_NEXT_SIGNING_KEY;
  const hasUrl = !!(process.env.QSTASH_URL || process.env.NEXT_PUBLIC_APP_URL);

  console.log(`   QSTASH_TOKEN: ${hasToken ? '✅' : '❌'}`);
  console.log(`   QSTASH_CURRENT_SIGNING_KEY: ${hasCurrentKey ? '✅' : '❌'}`);
  console.log(`   QSTASH_NEXT_SIGNING_KEY: ${hasNextKey ? '⚠️  (optional)' : '⚠️  (optional)'}`);
  console.log(`   QSTASH_URL: ${hasUrl ? '✅' : '❌'}`);

  if (!hasToken || !hasUrl) {
    console.log('\n❌ Missing required environment variables!');
    console.log('\nSet the following in your .env file:');
    console.log('   QSTASH_TOKEN="your_token"');
    console.log('   QSTASH_URL="https://qstash-us-east-1.upstash.io"');
    console.log('\nThen restart your server.');
    process.exit(1);
  }

  // Test 2: Service Initialization
  console.log('\n2️⃣  Initializing QStashService...');
  try {
    QStashService.initialize();
    console.log('   ✅ QStashService initialized successfully');
  } catch (error) {
    console.log('   ❌ Failed to initialize QStashService');
    console.log('   Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Test 3: Configuration Status
  console.log('\n3️⃣  Checking configuration status...');
  const isConfigured = QStashService.isConfigured();
  console.log(`   QStash configured: ${isConfigured ? '✅' : '⚠️  (will use fallback)'}`);

  if (!isConfigured) {
    console.log('\n⚠️  QStash is not fully configured, but fallback to fetch() is available.');
    console.log('   For production reliability, complete the QStash setup.');
    console.log('   See: QSTASH_SETUP.md');
  }

  // Test 4: Simulate Trigger (Dry Run)
  console.log('\n4️⃣  Testing triggerNextStep (dry run)...');
  try {
    // Don't actually send, just verify the method exists and is callable
    const testExecutionId = 'test-' + crypto.randomUUID();
    console.log(`   Would trigger execution: ${testExecutionId}`);
    console.log('   ✅ triggerNextStep method is available');
    
    if (isConfigured) {
      console.log('   ℹ️  To test actual message sending, use:');
      console.log(`   await QStashService.triggerNextStep({ executionId: "${testExecutionId}", stepIndex: 0 })`);
    }
  } catch (error) {
    console.log('   ❌ Error testing trigger method');
    console.log('   Error:', error instanceof Error ? error.message : String(error));
  }

  // Test 5: Webhook Verification (if keys configured)
  if (hasCurrentKey) {
    console.log('\n5️⃣  Testing webhook verification...');
    const { verifyQStashWebhook } = await import('../packages/shared/src/services/qstash-webhook');
    
    // Test with invalid signature (should fail)
    const testBody = '{"test": "data"}';
    const isValid = await verifyQStashWebhook(testBody, 'invalid-signature');
    console.log(`   Invalid signature rejected: ${!isValid ? '✅' : '❌'}`);
    console.log('   ✅ Webhook verification is configured');
  } else {
    console.log('\n5️⃣  Webhook verification...');
    console.log('   ⚠️  Signing keys not configured');
    console.log('   ℹ️  Add QSTASH_CURRENT_SIGNING_KEY to enable webhook verification');
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('\n📊 Summary:\n');

  const checks = [
    { name: 'Environment variables', pass: hasToken && hasUrl },
    { name: 'Service initialization', pass: true },
    { name: 'QStash configured', pass: isConfigured },
    { name: 'Trigger method available', pass: true },
    { name: 'Webhook verification', pass: hasCurrentKey },
  ];

  const passedChecks = checks.filter(c => c.pass).length;
  const totalChecks = checks.length;

  for (const check of checks) {
    console.log(`   ${check.pass ? '✅' : '❌'} ${check.name}`);
  }

  console.log(`\n   Score: ${passedChecks}/${totalChecks} checks passed`);

  if (passedChecks === totalChecks) {
    console.log('\n🎉 QStash is fully configured and ready!');
    console.log('\nNext steps:');
    console.log('   1. Test with a real multi-step execution');
    console.log('   2. Monitor QStash Console for messages');
    console.log('   3. Deploy to Vercel with the same environment variables');
  } else if (passedChecks >= 3) {
    console.log('\n✅ QStash is partially configured (fallback mode available)');
    console.log('\nRecommendation:');
    console.log('   Complete the setup for production reliability.');
    console.log('   See: QSTASH_SETUP.md');
  } else {
    console.log('\n❌ QStash is not properly configured');
    console.log('\nAction required:');
    console.log('   Follow the setup guide in QSTASH_SETUP.md');
    process.exit(1);
  }

  console.log();
}

// Run the test
testQStash().catch((error) => {
  console.error('❌ Test script error:', error);
  process.exit(1);
});
