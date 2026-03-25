/**
 * OpenAPI Documentation Endpoint
 *
 * Serves the OpenAPI specification JSON for TableStack API.
 * Access at: /api/docs/openapi.json
 *
 * @see Phase 2.2: API Documentation
 */

export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { openApiSpecification } from '@repo/shared';
import { withApiErrorHandler } from '@repo/shared';

async function openApiHandler(req: NextRequest) {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') || 'json';

  if (format === 'yaml') {
    // Convert to YAML if requested (would need yaml library)
    return NextResponse.json(
      { error: 'YAML format not supported, use JSON' },
      { status: 400 }
    );
  }

  return NextResponse.json(openApiSpecification, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export const GET = withApiErrorHandler(openApiHandler, 'EXECUTION_FAILED');
