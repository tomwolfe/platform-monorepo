import { db } from "@repo/database";
import { restaurants, restaurantReservations, restaurantWaitlist } from "@repo/database";
import { eq, desc } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import FloorPlan from '@/components/dashboard/FloorPlan';
import LiveView from '@/components/dashboard/LiveView';
import { updateTablePositions, updateTableStatus, updateRestaurantSettings, addTable, deleteTable, updateTableDetails, deleteReservation, updateWaitlistStatus, regenerateApiKey, createStripeConnectAccount } from './actions';
import { Trash2, Bell, UserCheck, CreditCard, Store, Utensils } from 'lucide-react';
import { UserMenu } from '@/components/nav/UserMenu';
import Link from 'next/link';

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
      restaurantReservations: {
        where: eq(restaurantReservations.isVerified, true),
        orderBy: (res: any, { asc }: any) => [asc(res.startTime)],
      },
      restaurantWaitlist: {
        orderBy: (wait: any, { desc }: any) => [desc(wait.createdAt)],
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
      <LiveView restaurantId={restaurantInternalId} />
      <header className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{restaurant.name} Dashboard</h1>
          <p className="text-gray-500">Manage your floor plan and restaurantReservations</p>
        </div>
        <div className="flex items-center gap-6">
          <UserMenu restaurantId={restaurantInternalId} />
          <div className="bg-gray-100 px-4 py-2 rounded-lg flex items-center space-x-4">
          <div>
            <span className="text-sm font-medium text-gray-600">API Key: </span>
            <code className="text-sm bg-gray-200 px-2 py-1 rounded">{restaurant.apiKey}</code>
          </div>
          <form action={async () => {
            'use server';
            await regenerateApiKey(restaurantInternalId);
          }}>
            <button 
              type="submit"
              className="text-xs bg-white border border-gray-300 px-2 py-1 rounded hover:bg-gray-50 transition-colors"
              title="Regenerate API Key"
            >
              Regenerate
            </button>
          </form>
        </div>
        </div>
      </header>

      <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="text-xl font-semibold mb-6">Floor Plan Editor</h2>
        <FloorPlan 
          initialTables={restaurant.tables} 
          restaurantReservations={restaurant.restaurantReservations.filter((r: any) => r.status === 'confirmed')}
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
        <h2 className="text-xl font-semibold mb-6 text-orange-600">Active Waitlist</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Guest</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Party</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Joined</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {restaurant.restaurantWaitlist.filter((w: any) => w.status !== 'seated').map((w: any) => (
                <tr key={w.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{w.guestName}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{w.partySize}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(w.createdAt!).toLocaleTimeString()}</td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold capitalize ${
                    w.status === 'notified' ? 'text-blue-600' : 'text-orange-600'
                  }`}>
                    {w.status}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    {w.status === 'waiting' && (
                      <form action={async () => {
                        'use server';
                        await updateWaitlistStatus(w.id, restaurantInternalId, 'notified');
                      }} className="inline">
                        <button type="submit" title="Notify Guest" className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                          <Bell className="w-4 h-4" />
                        </button>
                      </form>
                    )}
                    <form action={async () => {
                      'use server';
                      await updateWaitlistStatus(w.id, restaurantInternalId, 'seated');
                    }} className="inline">
                      <button type="submit" title="Seat Guest" className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors">
                        <UserCheck className="w-4 h-4" />
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {restaurant.restaurantWaitlist.filter((w: any) => w.status !== 'seated').length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-sm text-gray-500">Waitlist is currently empty.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
              {restaurant.restaurantReservations.map((res: any) => (
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
              {restaurant.restaurantReservations.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-4 text-center text-sm text-gray-500">No restaurantReservations found.</td>
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

        <Link href={`/dashboard/${restaurantId}/menu`} className="bg-amber-50 p-6 rounded-xl border border-amber-100 hover:shadow-md transition-shadow group">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-amber-900 font-semibold flex items-center gap-2">
              <Utensils className="w-4 h-4" />
              Menu Management
            </h3>
            <span className="text-amber-600 group-hover:translate-x-1 transition-transform">→</span>
          </div>
          <p className="text-sm text-amber-700">Manage your menu items and pricing</p>
        </Link>

        <div className="bg-purple-50 p-6 rounded-xl border border-purple-100 md:col-span-1 flex justify-between items-center">
          <div>
            <h3 className="text-purple-900 font-semibold mb-2 flex items-center">
              <CreditCard className="w-4 h-4 mr-2" />
              Payouts & Deposits
            </h3>
            {restaurant.stripeAccountId ? (
              <div className="flex items-center text-purple-700">
                <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                <span className="text-sm font-medium">Stripe Connected ({restaurant.stripeAccountId})</span>
              </div>
            ) : (
              <p className="text-sm text-purple-600">Connect your Stripe account to start accepting deposits.</p>
            )}
          </div>
          {!restaurant.stripeAccountId && (
            <form action={async () => {
              'use server';
              await createStripeConnectAccount(restaurantInternalId);
            }}>
              <button
                type="submit"
                className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
              >
                Connect Stripe
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
