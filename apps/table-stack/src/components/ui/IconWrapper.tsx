'use client';

import { useSyncExternalStore } from 'react';

// Module-level stable functions to avoid infinite loop warnings
const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Wrapper component to prevent hydration mismatch with lucide-react icons.
 * Icons are only rendered after client mount to avoid SVG path mismatches.
 */
export function IconAfterMount({
  children,
  fallback = <span className="inline-block w-4 h-4" />
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode
}) {
  const mounted = useSyncExternalStore(
    emptySubscribe,
    getClientSnapshot,
    getServerSnapshot
  );

  if (!mounted) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

