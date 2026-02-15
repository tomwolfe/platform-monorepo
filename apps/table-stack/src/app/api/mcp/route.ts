import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { SecurityProvider } from '@repo/auth';
import { GET_AVAILABILITY_TOOL, TOOL_METADATA, PARAMETER_ALIASES } from '@/lib/mcp';
import { z } from 'zod';

const availabilitySchema = z.object({
  restaurant_id: z.string(),
  date: z.string(),
  party_size: z.number().int().positive()
});

export async function GET(req: NextRequest) {
  if (!SecurityProvider.validateHeaders(req.headers)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    tools: [GET_AVAILABILITY_TOOL],
    metadata: TOOL_METADATA
  });
}

export async function POST(req: NextRequest) {
  if (!SecurityProvider.validateHeaders(req.headers)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { tool, params } = body;
    
    // Alias mapping
    const mappedParams: Record<string, any> = { ...params };
    for (const [alias, primary] of Object.entries(PARAMETER_ALIASES)) {
      if (mappedParams[alias] !== undefined && mappedParams[primary] === undefined) {
        mappedParams[primary] = mappedParams[alias];
      }
    }

    if (tool === 'get_availability') {
      const { restaurant_id, date, party_size } = availabilitySchema.parse(mappedParams);
      
      const origin = req.nextUrl.origin;
      const url = new URL(`${origin}/api/v1/availability`);
      url.searchParams.set('restaurantId', restaurant_id);
      url.searchParams.set('date', date);
      url.searchParams.set('partySize', party_size.toString());

      const response = await fetch(url.toString(), {
        headers: {
          'x-internal-key': process.env.INTERNAL_SYSTEM_KEY || ''
        }
      });

      if (!response.ok) {
        const errData = await response.json();
        return NextResponse.json({
          content: [{ type: 'text', text: `Error from availability service: ${JSON.stringify(errData)}` }],
          isError: true
        });
      }

      const data = await response.json();
      return NextResponse.json({
        content: [{ type: 'text', text: JSON.stringify(data) }]
      });
    }

    return NextResponse.json({ error: 'Unknown tool' }, { status: 400 });
  } catch (error: any) {
    console.error('MCP Tool Error:', error);
    return NextResponse.json({ 
      content: [{ type: 'text', text: error.message || 'Unknown error' }],
      isError: true 
    }, { status: 500 });
  }
}
