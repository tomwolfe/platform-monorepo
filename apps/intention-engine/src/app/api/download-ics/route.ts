import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseNaturalLanguageDate } from '@/lib/date-utils';
import { withApiErrorHandler, AppError } from '@repo/shared';

const DownloadIcsSchema = z.object({
  title: z.string().default('Event'),
  start: z.string().min(1),
  end: z.string().optional().nullable(),
  location: z.string().optional().default(''),
  description: z.string().optional().default(''),
});

function formatICalDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const eventsParam = searchParams.get('events');

  let events: any[] = [];

  if (eventsParam) {
    try {
      events = JSON.parse(eventsParam);
    } catch (e) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Invalid events JSON',
        statusCode: 400,
      });
    }
  } else {
    const params = Object.fromEntries(searchParams.entries());
    const validatedParams = DownloadIcsSchema.safeParse(params);
    if (!validatedParams.success) {
      throw new AppError({
        code: 'VALIDATION_ERROR',
        message: 'Invalid parameters',
        statusCode: 400,
        details: validatedParams.error.format(),
      });
    }
    events = [{
      title: validatedParams.data.title,
      start: validatedParams.data.start,
      end: validatedParams.data.end,
      location: validatedParams.data.location,
      description: validatedParams.data.description,
    }];
  }

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IntentionEngine//EN',
  ];

  for (const event of events) {
    const startDate = await parseNaturalLanguageDate(event.start);
    let endDate = event.end ? await parseNaturalLanguageDate(event.end) : new Date(startDate.getTime() + 60 * 60 * 1000);

    if (isNaN(endDate.getTime()) || endDate <= startDate) {
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    }

    icsLines.push(
      'BEGIN:VEVENT',
      `SUMMARY:${event.title}`,
      `DTSTART:${formatICalDate(startDate)}`,
      `DTEND:${formatICalDate(endDate)}`,
      `LOCATION:${event.location || ''}`,
      `DESCRIPTION:${(event.description || '').replace(/\n/g, '\\n')}`,
      'END:VEVENT'
    );
  }

  icsLines.push('END:VCALENDAR');

  const icsContent = icsLines.join('\r\n');
  const filename = events.length === 1
    ? `${events[0].title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.ics`
    : 'events.ics';

  return new NextResponse(icsContent, {
    headers: {
      'Content-Type': 'text/calendar',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

export const GET = withApiErrorHandler(getHandler, { serviceName: 'download-ics' });
