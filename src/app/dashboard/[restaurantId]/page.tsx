import { db } from '@/db';
import { restaurants, reservations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import FloorPlan from '@/components/dashboard/FloorPlan';
import { updateTablePositions, updateTableStatus } from './actions';
import { currentUser } from '@clerk/nextjs/server';

export default async function DashboardPage(props: { params: Promise<{ restaurantId: string }> }) {
  const params = await props.params;
  const restaurantId = params.restaurantId;
  const user = await currentUser();

  if (!user) {
    redirect('/sign-in');
  }

  // UUID regex check
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(restaurantId);

  const restaurant = await db.query.restaurants.findFirst({
    where: isUuid 
      ? eq(restaurants.id, restaurantId) 
      : eq(restaurants.slug, restaurantId),
    with: {
      tables: true,
      reservations: {
        where: eq(reservations.isVerified, true),
        orderBy: (reservations, { asc }) => [asc(reservations.startTime)],
      }
    },
  });

  if (!restaurant) {
    notFound();
  }

  if (restaurant.ownerId !== user.id) {
    redirect('/onboarding');
  }

  async function handleSave(tables: { id: string, xPos: number | null, yPos: number | null }[]) {
    'use server';
    await updateTablePositions(
      tables.map(t => ({ id: t.id, xPos: t.xPos, yPos: t.yPos })),
      restaurantId
    );
  }

  async function handleStatusChange(tableId: string, status: 'vacant' | 'occupied' | 'dirty') {
    'use server';
    await updateTableStatus(tableId, status, restaurantId);
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{restaurant.name} Dashboard</h1>
          <p className="text-gray-500">Manage your floor plan and reservations</p>
        </div>
        <div className="bg-gray-100 px-4 py-2 rounded-lg">
          <span className="text-sm font-medium text-gray-600">API Key: </span>
          <code className="text-sm bg-gray-200 px-2 py-1 rounded">{restaurant.apiKey}</code>
        </div>
      </header>

      <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6">Floor Plan Editor</h2>
        <FloorPlan 
          initialTables={restaurant.tables} 
          reservations={restaurant.reservations}
          onSave={handleSave} 
          onStatusChange={handleStatusChange}
          restaurantId={restaurant.id}
        />
      </section>

      <section className="mt-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6">Confirmed Reservations</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Guest</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {restaurant.reservations.map((res) => (
                <tr key={res.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{res.guestName}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{res.partySize}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(res.startTime).toLocaleString()}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600 font-semibold">Confirmed</td>
                </tr>
              ))}
              {restaurant.reservations.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-4 text-center text-sm text-gray-500">No confirmed reservations found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-blue-50 p-6 rounded-xl border border-blue-100">
          <h3 className="text-blue-900 font-semibold mb-2">Total Tables</h3>
          <p className="text-3xl font-bold text-blue-600">{restaurant.tables.length}</p>
        </div>
        {/* More stats could go here */}
      </section>
    </div>
  );
}
