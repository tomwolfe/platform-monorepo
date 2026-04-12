import DashboardClient from "./DashboardClient";

// Force dynamic rendering to avoid SSR issues with wagmi hooks
export const dynamic = "force-dynamic";

export default function DriverDashboardPage() {
  return <DashboardClient />;
}
