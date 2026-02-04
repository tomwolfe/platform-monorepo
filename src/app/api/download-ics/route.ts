import { NextRequest, NextResponse } from 'next/server';

function formatICalDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function parseDateTime(dt: string): Date {
  const d = new Date(dt);
  if (!isNaN(d.getTime())) return d;
  
  // Basic "tomorrow" handling
  if (dt.toLowerCase().includes("tomorrow")) {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    
    // Try to extract time like "7pm" or "19:00"
    const timeMatch = dt.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2] || "0");
      const ampm = (timeMatch[3] || "").toLowerCase();
      
      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
      
      tomorrow.setHours(hours, minutes, 0, 0);
      return tomorrow;
    }
    return tomorrow;
  }
  return d;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get('title') || 'Event';
  const startStr = searchParams.get('start') || '';
  const endStr = searchParams.get('end') || '';
  const location = searchParams.get('location') || '';

  const startDate = parseDateTime(startStr);
  const endDate = parseDateTime(endStr);

  // If endDate is invalid or before startDate, make it 1 hour after startDate
  if (isNaN(endDate.getTime()) || endDate <= startDate) {
    endDate.setTime(startDate.getTime() + 60 * 60 * 1000);
  }

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IntentionEngine//EN',
    'BEGIN:VEVENT',
    `SUMMARY:${title}`,
    `DTSTART:${formatICalDate(startDate)}`,
    `DTEND:${formatICalDate(endDate)}`,
    `LOCATION:${location}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  return new NextResponse(icsContent, {
    headers: {
      'Content-Type': 'text/calendar',
      'Content-Disposition': `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.ics"`,
    },
  });
}
