/**
 * Proactive Cache Warming Hook
 * 
 * Detects user typing and triggers cache warming after a debounce period.
 * This ensures the LiveOperationalState is pre-fetched before the actual chat request.
 * 
 * Usage:
 *   function ChatInput() {
 *     const { warmCache } = useProactiveCacheWarming();
 *     
 *     const handleTyping = (text: string) => {
 *       warmCache(text);
 *       // ... rest of typing handler
 *     };
 *   }
 * 
 * @package apps/intention-engine
 */

'use client';

import { useCallback, useRef, useEffect } from 'react';

export interface UseProactiveCacheWarmingOptions {
  /** Debounce delay in ms (default: 500ms) */
  debounceMs?: number;
  /** Minimum message length to trigger warm (default: 10 chars) */
  minLength?: number;
  /** Enable/disable cache warming (default: true) */
  enabled?: boolean;
  /** Debug mode - logs cache warm results */
  debug?: boolean;
}

export interface UseProactiveCacheWarmingReturn {
  /** Call this when user types */
  warmCache: (messagePreview: string, userLocation?: { lat: number; lng: number }) => void;
  /** Cancel pending warm request */
  cancel: () => void;
  /** Whether a warm request is in progress */
  isWarming: boolean;
  /** Last warm result */
  lastResult: CacheWarmResult | null;
}

export interface CacheWarmResult {
  warmed: boolean;
  restaurants: number;
  cacheHits: number;
  cacheWarmed: number;
  timestamp: number;
}

let userLocationCache: { lat: number; lng: number } | undefined;

/**
 * Set user location globally for cache warming
 * Call this once when user location is known
 */
export function setUserLocationForCacheWarming(location: { lat: number; lng: number }) {
  userLocationCache = location;
}

export function useProactiveCacheWarming(
  options: UseProactiveCacheWarmingOptions = {}
): UseProactiveCacheWarmingReturn {
  const {
    debounceMs = 500,
    minLength = 10,
    enabled = true,
    debug = false,
  } = options;

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isWarmingRef = useRef(false);
  const lastResultRef = useRef<CacheWarmResult | null>(null);

  const cancel = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const warmCache = useCallback(
    (messagePreview: string, userLocation?: { lat: number; lng: number }) => {
      if (!enabled) return;
      if (messagePreview.length < minLength) return;

      // Cancel any pending warm request
      cancel();

      // Debounce the warm request
      timeoutRef.current = setTimeout(async () => {
        if (isWarmingRef.current) return; // Avoid concurrent requests

        isWarmingRef.current = true;
        const location = userLocation || userLocationCache;

        try {
          const response = await fetch('/api/chat/warm-cache', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messagePreview,
              userLocation: location,
            }),
          });

          const data = await response.json();

          if (debug && data.warmed) {
            console.log('[CacheWarm]', {
              restaurants: data.restaurants,
              cacheHits: data.cacheHits,
              cacheWarmed: data.cacheWarmed,
              results: data.results,
            });
          }

          lastResultRef.current = {
            warmed: data.warmed,
            restaurants: data.restaurants || 0,
            cacheHits: data.cacheHits || 0,
            cacheWarmed: data.cacheWarmed || 0,
            timestamp: Date.now(),
          };
        } catch (error) {
          if (debug) {
            console.warn('[CacheWarm] Error:', error);
          }
          // Silently fail - cache warming is best-effort
        } finally {
          isWarmingRef.current = false;
        }
      }, debounceMs);
    },
    [cancel, debounceMs, enabled, minLength, debug]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => cancel();
  }, [cancel]);

  return {
    warmCache,
    cancel,
    get isWarming() { return isWarmingRef.current; },
    get lastResult() { return lastResultRef.current; },
  };
}

/**
 * Higher-order component wrapper for cache warming
 * 
 * Usage:
 *   const ChatInputWithCacheWarming = withProactiveCacheWarming(ChatInput);
 */
export function withProactiveCacheWarming<P extends object>(
  WrappedComponent: React.ComponentType<P & { warmCache: UseProactiveCacheWarmingReturn['warmCache'] }>
) {
  return function WithProactiveCacheWarming(props: P) {
    const { warmCache } = useProactiveCacheWarming();
    return <WrappedComponent {...props} warmCache={warmCache} />;
  };
}
