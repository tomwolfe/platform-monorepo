import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "./config";

const customOpenAI = createOpenAI({
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL,
});

/**
 * Parse natural language date strings
 * 
 * ENHANCEMENT: Expanded basic fallback parsing to handle common patterns
 * without relying on LLM for simple temporal math
 */
export async function parseNaturalLanguageDate(dateStr: string): Promise<Date> {
  // Try native Date parsing first for ISO strings
  const d = new Date(dateStr);
  if (!isNaN(d.getTime()) && dateStr.includes("-")) return d;

  // Try enhanced basic parsing before falling back to LLM
  const basicParsed = enhancedBasicParseDateTime(dateStr);
  if (basicParsed) return basicParsed;

  // Use LLM for complex natural language dates
  try {
    const { text } = await generateText({
      model: customOpenAI(env.LLM_MODEL),
      system: `You are a date parsing utility.
Convert the user's natural language date string into an ISO 8601 timestamp.
Current time: ${new Date().toISOString()}
Target format: YYYY-MM-DDTHH:mm:ssZ

Return ONLY the ISO string.`,
      prompt: dateStr,
    });

    const parsedDate = new Date(text.trim());
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  } catch (error) {
    console.error("LLM date parsing failed, falling back to basic logic:", error);
  }

  // Final fallback
  return enhancedBasicParseDateTime(dateStr) || new Date(dateStr);
}

/**
 * Enhanced basic date/time parser
 * 
 * Handles common patterns without LLM:
 * - "tomorrow", "today", "yesterday"
 * - "next week", "next month", "next year"
 * - "in X days/hours/weeks/months"
 * - "X days ago", "X hours ago"
 * - Time specifications like "tomorrow at 3pm"
 * 
 * @param dt - Date string to parse
 * @returns Parsed Date or invalid Date if unparseable
 */
function enhancedBasicParseDateTime(dt: string): Date | null {
  const normalized = dt.toLowerCase().trim();
  const now = new Date();
  
  // Handle "today"
  if (normalized.includes("today")) {
    const time = extractTime(normalized);
    const result = new Date(now);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    } else {
      result.setHours(0, 0, 0, 0);
    }
    return result;
  }
  
  // Handle "tomorrow"
  if (normalized.includes("tomorrow")) {
    const time = extractTime(normalized);
    const result = new Date(now);
    result.setDate(now.getDate() + 1);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    } else {
      result.setHours(0, 0, 0, 0);
    }
    return result;
  }
  
  // Handle "yesterday"
  if (normalized.includes("yesterday")) {
    const time = extractTime(normalized);
    const result = new Date(now);
    result.setDate(now.getDate() - 1);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    } else {
      result.setHours(0, 0, 0, 0);
    }
    return result;
  }
  
  // Handle "next week"
  if (normalized.includes("next week")) {
    const result = new Date(now);
    result.setDate(now.getDate() + 7);
    const time = extractTime(normalized);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    }
    return result;
  }
  
  // Handle "next month"
  if (normalized.includes("next month")) {
    const result = new Date(now);
    result.setMonth(now.getMonth() + 1);
    const time = extractTime(normalized);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    }
    return result;
  }
  
  // Handle "next year"
  if (normalized.includes("next year")) {
    const result = new Date(now);
    result.setFullYear(now.getFullYear() + 1);
    const time = extractTime(normalized);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    }
    return result;
  }
  
  // Handle "in X days/hours/weeks/months"
  const inMatch = normalized.match(/in\s+(\d+)\s*(day|hour|week|month|year)s?/);
  if (inMatch) {
    const value = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    const result = new Date(now);
    
    switch (unit) {
      case "day":
        result.setDate(now.getDate() + value);
        break;
      case "hour":
        result.setHours(now.getHours() + value);
        break;
      case "week":
        result.setDate(now.getDate() + (value * 7));
        break;
      case "month":
        result.setMonth(now.getMonth() + value);
        break;
      case "year":
        result.setFullYear(now.getFullYear() + value);
        break;
    }
    
    const time = extractTime(normalized);
    if (time) {
      result.setHours(time.hours, time.minutes, 0, 0);
    }
    return result;
  }
  
  // Handle "X days/hours/weeks/months ago"
  const agoMatch = normalized.match(/(\d+)\s*(day|hour|week|month|year)s?\s*ago/);
  if (agoMatch) {
    const value = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2];
    const result = new Date(now);
    
    switch (unit) {
      case "day":
        result.setDate(now.getDate() - value);
        break;
      case "hour":
        result.setHours(now.getHours() - value);
        break;
      case "week":
        result.setDate(now.getDate() - (value * 7));
        break;
      case "month":
        result.setMonth(now.getMonth() - value);
        break;
      case "year":
        result.setFullYear(now.getFullYear() - value);
        break;
    }
    
    return result;
  }
  
  // Handle "this weekend" (next Saturday or Sunday)
  if (normalized.includes("weekend")) {
    const result = new Date(now);
    const dayOfWeek = now.getDay();
    // If today is Saturday or Sunday, return today
    // Otherwise, return next Saturday
    const daysUntilSaturday = (6 - dayOfWeek + 7) % 7;
    result.setDate(now.getDate() + daysUntilSaturday);
    result.setHours(0, 0, 0, 0);
    return result;
  }
  
  // Handle "next monday", "next tuesday", etc.
  const nextDayMatch = normalized.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (nextDayMatch) {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const targetDay = days.indexOf(nextDayMatch[1].toLowerCase());
    const currentDay = now.getDay();
    const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7; // Always go to next week
    
    const result = new Date(now);
    result.setDate(now.getDate() + daysUntilTarget);
    result.setHours(0, 0, 0, 0);
    return result;
  }
  
  return null;
}

/**
 * Extract time from a natural language string
 * Handles formats like:
 * - "at 3pm", "at 3:30pm", "at 15:00"
 * - "3pm", "3:30pm", "15:00"
 */
function extractTime(str: string): { hours: number; minutes: number } | null {
  // Try "at HH:MM am/pm" format
  const timeAtMatch = str.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeAtMatch) {
    return parseTimeComponents(timeAtMatch[1], timeAtMatch[2], timeAtMatch[3]);
  }
  
  // Try standalone time format
  const timeMatch = str.match(/(?<!\d)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!\d)/i);
  if (timeMatch) {
    return parseTimeComponents(timeMatch[1], timeMatch[2], timeMatch[3]);
  }
  
  return null;
}

/**
 * Parse time components into hours and minutes
 */
function parseTimeComponents(hoursStr: string, minutesStr: string | undefined, ampmStr: string | undefined): { hours: number; minutes: number } | null {
  let hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr || "0", 10);
  const ampm = (ampmStr || "").toLowerCase();
  
  if (isNaN(hours) || isNaN(minutes)) {
    return null;
  }
  
  // Handle AM/PM
  if (ampm === "pm" && hours < 12) {
    hours += 12;
  }
  if (ampm === "am" && hours === 12) {
    hours = 0;
  }
  
  // Validate hours and minutes
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  
  return { hours, minutes };
}
