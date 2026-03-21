import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NervousSystemProvider, NervousSystemPulse } from "@repo/ui-theme";
import { Web3Provider } from "@/components/web3/Web3Provider";
import "./globals.css";

export const dynamic = 'force-dynamic';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TableStack",
  description: "Intelligent Reservation Engine",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
          suppressHydrationWarning
        >
          <Web3Provider>
            <NervousSystemProvider autoSubscribe={true}>
              {children}
              <NervousSystemPulse includeProvider={false} />
            </NervousSystemProvider>
          </Web3Provider>
        </body>
      </html>
    </ClerkProvider>
  );
}
