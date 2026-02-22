import type { Metadata } from "next";
import { NervousSystemProvider, NervousSystemPulse } from "@repo/ui-theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Intention Engine",
  description: "Deterministic, auditable intent execution",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen">
        <NervousSystemProvider autoSubscribe={true}>
          {children}
          <NervousSystemPulse includeProvider={false} />
        </NervousSystemProvider>
      </body>
    </html>
  );
}
