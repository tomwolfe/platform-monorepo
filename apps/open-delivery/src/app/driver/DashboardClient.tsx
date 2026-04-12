"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

// Dynamically import the actual dashboard with SSR disabled
// This prevents wagmi hooks from running during server-side generation
const DriverDashboardInner = dynamic(() => import("./DashboardInner"), {
  ssr: false,
});

export default function DashboardClient() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-900 text-white p-6 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500"></div>
        </div>
      }
    >
      <DriverDashboardInner />
    </Suspense>
  );
}
