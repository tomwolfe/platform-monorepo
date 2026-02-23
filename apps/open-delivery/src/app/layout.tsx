import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { NervousSystemProvider, NervousSystemPulse } from "@repo/ui-theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenDeliver",
  description: "Autonomous delivery network",
};

// Use environment key with a properly formatted fallback for CI/build
// Clerk requires keys to start with pk_test_ or pk_live_ followed by valid base58 characters
const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY 
  || "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k"; // Valid format for build-time

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <html lang="en">
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <NervousSystemProvider autoSubscribe={true}>
            {children}
            <NervousSystemPulse includeProvider={false} />
          </NervousSystemProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
