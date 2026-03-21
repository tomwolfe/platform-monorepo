#!/usr/bin/env node
const { neon } = require('@neondatabase/serverless');

async function verify() {
  const sql = neon(process.env.DATABASE_URL);
  
  const result = await sql.query(`
    SELECT column_name, data_type, column_default 
    FROM information_schema.columns 
    WHERE table_name = 'orders' 
    AND column_name IN ('payout_status', 'payout_processed_at')
  `);
  
  console.table(result);
}

verify();
