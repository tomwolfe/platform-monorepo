import { ShoppingBag, Truck } from "lucide-react";
import Link from "next/link";

export default function Home() {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center bg-[var(--background)] p-4 font-sans text-[var(--foreground)]"
      style={{
        fontFamily: "var(--font-geist-sans)",
      }}
    >
      <main className="flex w-full max-w-4xl flex-col items-center gap-12 py-12 text-center">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-4xl font-bold tracking-tighter sm:text-5xl md:text-6xl">
            OpenDeliver
          </h1>
          <p className="max-w-2xl text-lg text-neutral-600 dark:text-neutral-400 md:text-xl">
            The open-source protocol for local logistics. Connect, deliver, and
            earn.
          </p>
        </div>

        <div className="grid w-full max-w-2xl grid-cols-1 gap-6 md:grid-cols-2">
          <Link
            href="/customer"
            className="group flex flex-col gap-4 rounded-lg border border-neutral-200 bg-transparent p-6 text-left transition-colors hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900"
            aria-label="Navigate to the customer portal"
          >
            <div className="flex items-center gap-4">
              <ShoppingBag className="h-8 w-8 text-neutral-500 transition-colors group-hover:text-neutral-900 dark:text-neutral-400 dark:group-hover:text-neutral-50" />
              <h2 className="text-2xl font-semibold">I am a Customer</h2>
            </div>
            <p className="text-neutral-600 dark:text-neutral-400">
              Order from local vendors and track in real-time.
            </p>
          </Link>

          <Link
            href="/driver"
            className="group flex flex-col gap-4 rounded-lg border border-neutral-200 bg-transparent p-6 text-left transition-colors hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900"
            aria-label="Navigate to the driver portal"
          >
            <div className="flex items-center gap-4">
              <Truck className="h-8 w-8 text-neutral-500 transition-colors group-hover:text-neutral-900 dark:text-neutral-400 dark:group-hover:text-neutral-50" />
              <h2 className="text-2xl font-semibold">I am a Driver</h2>
            </div>
            <p className="text-neutral-600 dark:text-neutral-400">
              Join the decentralized network and fulfill local orders.
            </p>
          </Link>
        </div>
      </main>
    </div>
  );
}
