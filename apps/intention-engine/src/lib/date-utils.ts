import { parseDate, parse } from "chrono-node";

/**
 * Parse natural language date strings using chrono-node
 *
 * This provides deterministic, sub-millisecond date parsing without
 * relying on expensive LLM calls.
 *
 * Features:
 * - Supports relative dates: "tomorrow", "next week", "in 2 days"
 * - Supports absolute dates: "March 15, 2024", "2024-03-15"
 * - Supports time specifications: "tomorrow at 3pm", "next Monday at 10:00"
 * - Supports date ranges: "from Monday to Friday"
 * - Multi-language support (English by default)
 *
 * Performance:
 * - Typical parsing time: <1ms
 * - No network calls
 * - Deterministic results
 *
 * @param dateStr - Natural language date string
 * @param referenceDate - Optional reference date for relative parsing (defaults to now)
 * @returns Parsed Date or null if unparseable
 */
export function parseNaturalLanguageDate(
  dateStr: string,
  referenceDate?: Date,
): Date | null {
  // Try native Date parsing first for ISO strings and standard formats
  const nativeDate = new Date(dateStr);
  if (!isNaN(nativeDate.getTime()) && dateStr.includes("-")) {
    return nativeDate;
  }

  // Use chrono-node for natural language parsing
  const refDate = referenceDate || new Date();
  const parsed = parseDate(dateStr, refDate, {
    forwardDate: true, // Prefer future dates for ambiguous cases
  });

  if (parsed) {
    return parsed;
  }

  // Fallback: try chrono with more lenient parsing
  const results = parse(dateStr, refDate, {
    forwardDate: true,
  });

  if (results.length > 0) {
    return results[0]!.start.date();
  }

  // Final fallback: try native Date (will return Invalid Date if unparseable)
  const fallbackDate = new Date(dateStr);
  if (!isNaN(fallbackDate.getTime())) {
    return fallbackDate;
  }

  return null;
}

/**
 * Parse natural language date with strict validation
 *
 * @param dateStr - Natural language date string
 * @param referenceDate - Optional reference date for relative parsing
 * @param options - Parsing options
 * @returns Parsed Date or throws error if unparseable
 */
export function parseNaturalLanguageDateStrict(
  dateStr: string,
  referenceDate?: Date,
  options?: {
    /** Error message if parsing fails */
    errorMessage?: string;
    /** Whether to allow past dates (default: false) */
    allowPastDates?: boolean;
  },
): Date {
  const refDate = referenceDate || new Date();
  const parsed = parseNaturalLanguageDate(dateStr, refDate);

  if (!parsed) {
    throw new Error(
      options?.errorMessage || `Unable to parse date string: "${dateStr}"`,
    );
  }

  // Validate past dates if not allowed
  if (!options?.allowPastDates && parsed.getTime() < refDate.getTime()) {
    throw new Error(
      `Parsed date "${dateStr}" resolves to ${parsed.toISOString()}, which is in the past`,
    );
  }

  return parsed;
}

/**
 * Parse multiple date candidates from a natural language string
 *
 * @param dateStr - Natural language date string
 * @param referenceDate - Optional reference date for relative parsing
 * @returns Array of parsed dates (may be empty if none found)
 */
export function parseMultipleDateCandidates(
  dateStr: string,
  referenceDate?: Date,
): Date[] {
  const refDate = referenceDate || new Date();
  const results = parse(dateStr, refDate, {
    forwardDate: true,
  });

  return results.map((result) => result.start.date());
}

/**
 * Check if a string contains date/time information
 *
 * @param dateStr - String to check
 * @returns True if date/time information is detected
 */
export function containsDateInformation(dateStr: string): boolean {
  const results = parse(dateStr, new Date(), {
    forwardDate: true,
  });
  return results.length > 0;
}

/**
 * Extract date and time components from a natural language string
 *
 * @param dateStr - Natural language date string
 * @param referenceDate - Optional reference date for relative parsing
 * @returns Object with date, time, and confidence information
 */
export function extractDateTimeComponents(
  dateStr: string,
  referenceDate?: Date,
): {
  date: Date | null;
  hasTime: boolean;
  hasDate: boolean;
  confidence: "high" | "medium" | "low";
  originalText: string;
} | null {
  const refDate = referenceDate || new Date();
  const results = parse(dateStr, refDate, {
    forwardDate: true,
  });

  if (results.length === 0) {
    return null;
  }

  const result = results[0]!;
  const date = result.start.date();

  // Determine if time was specified
  const hasTime =
    result.start.isCertain("hour") || result.start.isCertain("minute");
  const hasDate =
    result.start.isCertain("day") ||
    result.start.isCertain("month") ||
    result.start.isCertain("year");

  // Calculate confidence based on certainty of components
  let confidence: "high" | "medium" | "low" = "high";
  // Use hasTime and hasDate which were already computed above
  if (!hasDate) {
    confidence = "low";
  } else if (!hasTime) {
    confidence = "medium";
  }

  return {
    date,
    hasTime,
    hasDate,
    confidence,
    originalText: result.text,
  };
}
