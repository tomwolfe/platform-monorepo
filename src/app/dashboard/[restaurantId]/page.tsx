import { db } from '@/db';
import { restaurants, reservations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import FloorPlan from '@/components/dashboard/FloorPlan';
import { updateTablePositions, updateTableStatus, updateRestaurantSettings, addTable, deleteTable, updateTableDetails, deleteReservation } from './actions';
import { currentUser } from '@clerk/nextjs/server';
import { Trash2 } from 'lucide-react';

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

  const restaurantInternalId = restaurant.id;

  if (restaurant.ownerId !== user.id) {
    redirect('/onboarding');
  }

  async function handleSave(tables: { id: string, xPos: number | null, yPos: number | null }[]) {
    'use server';
    await updateTablePositions(
      tables.map(t => ({ id: t.id, xPos: t.xPos, yPos: t.yPos })),
      restaurantInternalId
    );
  }

  async function handleStatusChange(tableId: string, status: 'vacant' | 'occupied' | 'dirty') {
    'use server';
    await updateTableStatus(tableId, status, restaurantInternalId);
  }

  async function handleAddTable() {
    'use server';
    await addTable(restaurantInternalId);
  }

  async function handleDeleteTable(tableId: string) {
    'use server';
    await deleteTable(tableId, restaurantInternalId);
  }

  async function handleUpdateDetails(tableId: string, details: { tableNumber: string, minCapacity: number, maxCapacity: number }) {
    'use server';
    await updateTableDetails(tableId, restaurantInternalId, details);
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
          reservations={restaurant.reservations.filter(r => r.status === 'confirmed')}
          onSave={handleSave} 
          onStatusChange={handleStatusChange}
          onAdd={handleAddTable}
          onDelete={handleDeleteTable}
          onUpdateDetails={handleUpdateDetails}
          restaurantId={restaurantInternalId}
        />
      </section>

      <section className="mt-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6">Restaurant Settings</h2>
        <form action={async (formData) => {
          'use server';
          await updateRestaurantSettings(restaurantInternalId, formData);
        }} className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Opening Time (HH:mm)</label>
            <input 
              type="text" 
              name="openingTime" 
              defaultValue={restaurant.openingTime || '09:00'} 
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="09:00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Closing Time (HH:mm)</label>
            <input 
              type="text" 
              name="closingTime" 
              defaultValue={restaurant.closingTime || '22:00'} 
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="22:00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
            <input 
              type="text" 
              name="timezone" 
              defaultValue={restaurant.timezone || 'UTC'} 
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="America/New_York"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Default Duration (minutes)</label>
            <input 
              type="number" 
              name="defaultDurationMinutes" 
              defaultValue={restaurant.defaultDurationMinutes || 90} 
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Days Open (comma separated)</label>
            <input 
              type="text" 
              name="daysOpen" 
              defaultValue={restaurant.daysOpen || 'monday,tuesday,wednesday,thursday,friday,saturday,sunday'} 
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div className="md:col-span-2">
            <button 
              type="submit" 
              className="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors"
            >
              Save Settings
            </button>
          </div>
        </form>
      </section>

      <section className="mt-8 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6">Recent Reservations</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Guest</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Size</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {restaurant.reservations.map((res) => (
                <tr key={res.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{res.guestName}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{res.partySize}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(res.startTime).toLocaleString()}</td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold capitalize ${
                    res.status === 'confirmed' ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {res.status}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <form action={async () => {
                      'use server';
                      await deleteReservation(res.id, restaurantInternalId);
                    }} className="inline">
                      <button type="submit" className="text-red-600 hover:text-red-900 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {restaurant.reservations.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-sm text-gray-500">No reservations found.</td>
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
