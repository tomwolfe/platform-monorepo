/**
 * Restaurant opening hours utilities.
 *
 * Pure, testable functions for checking if a restaurant is open
 * at a given time, handling overnight hours (e.g. 18:00–02:00).
 *
 * @package @repo/shared
 */

/**
 * Check if a restaurant is open at a specific time.
 *
 * Handles overnight hours where closing time is before opening time
 * (e.g. a restaurant open from 18:00 to 02:00 spans midnight).
 *
 * @param currentTime - Current time in "HH:mm" 24h format (e.g. "14:30")
 * @param openingTime - Opening time in "HH:mm" 24h format (e.g. "09:00")
 * @param closingTime - Closing time in "HH:mm" 24h format (e.g. "22:00")
 * @returns true if the restaurant is currently open
 */
export function isRestaurantOpenAtTime(
  currentTime: string,
  openingTime: string,
  closingTime: string,
): boolean {
  // Handle overnight hours (e.g. 18:00 to 02:00)
  const isOvernight = closingTime < openingTime;
  return isOvernight
    ? currentTime >= openingTime || currentTime <= closingTime
    : currentTime >= openingTime && currentTime <= closingTime;
}

/**
 * Check if a day is within the restaurant's open days.
 *
 * @param dayOfWeek - Day name in lowercase (e.g. "monday")
 * @param daysOpen - Array of lowercase day names (e.g. ["monday", "tuesday"])
 * @returns true if the restaurant is open on this day
 */
export function isRestaurantOpenOnDay(
  dayOfWeek: string,
  daysOpen: string[],
): boolean {
  return daysOpen.includes(dayOfWeek.toLowerCase());
}
