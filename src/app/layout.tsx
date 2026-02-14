import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import Link from "next/link";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "StoreFront",
  description: "Product Search and Inventory Management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <nav className="border-b">
          <div className="container mx-auto px-4 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl">StoreFront</Link>
            <div className="flex gap-6">
              <Link href="/search" className="text-sm font-medium hover:text-primary">Search</Link>
              <Link href="/inventory" className="text-sm font-medium hover:text-primary">Inventory</Link>
            </div>
          </div>
        </nav>
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
