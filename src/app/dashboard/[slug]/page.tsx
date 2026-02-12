import { db } from '@/db';
import { restaurants, restaurantTables } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import FloorPlan from '@/components/dashboard/FloorPlan';
import { updateTablePositions } from './actions';

export default async function DashboardPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const slug = params.slug;

  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.slug, slug),
    with: {
      tables: true,
    },
  });

  if (!restaurant) {
    notFound();
  }

  async function handleSave(tables: any[]) {
    'use server';
    await updateTablePositions(
      tables.map(t => ({ id: t.id, xPos: t.xPos, yPos: t.yPos })),
      slug
    );
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
          onSave={handleSave} 
        />
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
