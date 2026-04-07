"use client";

import { useEffect, useState } from "react";

/**
 * Wrapper component to prevent hydration mismatch with lucide-react icons.
 * Uses useEffect-based mounting detection instead of useSyncExternalStore hack
 * to avoid UI pop-in and layout shifts.
 *
 * The component renders a stable placeholder during SSR and switches to
 * actual icons only after client hydration completes.
 */
export function IconAfterMount({
  children,
  fallback = <span className="inline-block w-4 h-4" aria-hidden="true" />,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
