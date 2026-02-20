import { db } from "@repo/database";
import { restaurants, restaurantProducts, inventoryLevels } from "@repo/database";
import { eq, desc } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { getMenuItems, deleteMenuItem } from '../actions';
import { UserMenu } from '@/components/nav/UserMenu';
import { Plus, Trash2, Edit, Package, DollarSign, Tag } from 'lucide-react';
import CreateMenuItemForm from './CreateMenuItemForm';

export default async function MenuManagementPage(props: { params: Promise<{ restaurantId: string }> }) {
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
  });

  if (!restaurant) {
    notFound();
  }

  if (restaurant.ownerId !== user.id) {
    redirect('/onboarding');
  }

  const menuItems = await getMenuItems(restaurantId);

  // Group items by category
  const categories = Array.from(new Set(menuItems.map((item: { category: string }) => item.category))) as string[];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Menu Management</h1>
          <p className="text-gray-500">Manage your restaurant&apos;s menu items and pricing</p>
        </div>
        <div className="flex items-center gap-4">
          <CreateMenuItemForm restaurantId={restaurantId} />
          <UserMenu restaurantId={restaurantId} />
        </div>
      </header>

      {categories.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
          <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">No Menu Items</h2>
          <p className="text-gray-500 mb-6">Start by adding your first menu item</p>
          <CreateMenuItemForm restaurantId={restaurantId} />
        </div>
      ) : (
        <div className="space-y-8">
          {categories.map((category) => (
            <section key={category} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <Tag className="w-5 h-5 text-blue-600" />
                  <h2 className="text-xl font-bold text-gray-900">{category}</h2>
                  <span className="text-sm text-gray-500 bg-white px-2 py-1 rounded-full border">
                    {menuItems.filter((item: { category: string }) => item.category === category).length} items
                  </span>
                </div>
              </div>

              <div className="divide-y divide-gray-100">
                {menuItems
                  .filter((item: { category: string }) => item.category === category)
                  .map((item: { id: string | null; name: string; description: string | null; price: number | null; availableQuantity: number | null; category: string }) => (
                    <div
                      key={item.id}
                      className="p-6 hover:bg-gray-50 transition-colors flex items-center justify-between group"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-1">
                          <h3 className="text-lg font-semibold text-gray-900">{item.name}</h3>
                          {item.availableQuantity !== null && item.availableQuantity < 10 && (
                            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-medium">
                              Low Stock ({item.availableQuantity})
                            </span>
                          )}
                        </div>
                        <p className="text-gray-500 text-sm mb-2">{item.description || 'No description'}</p>
                        <div className="flex items-center gap-4 text-sm text-gray-500">
                          <div className="flex items-center gap-1">
                            <DollarSign className="w-4 h-4" />
                            <span className="font-semibold text-gray-700">${item.price?.toFixed(2)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Package className="w-4 h-4" />
                            <span>Stock: {item.availableQuantity ?? 'N/A'}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Edit item"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <form
                          action={async () => {
                            'use server';
                            await deleteMenuItem(item.id!, restaurantId);
                          }}
                          className="inline"
                        >
                          <button
                            type="submit"
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete item"
                            onClick={(e) => {
                              if (!confirm(`Are you sure you want to delete "${item.name}"?`)) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </form>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Quick Stats */}
      <section className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-blue-50 p-6 rounded-xl border border-blue-100">
          <h3 className="text-blue-900 font-semibold mb-2 flex items-center gap-2">
            <Package className="w-4 h-4" />
            Total Items
          </h3>
          <p className="text-3xl font-bold text-blue-600">{menuItems.length}</p>
        </div>
        <div className="bg-green-50 p-6 rounded-xl border border-green-100">
          <h3 className="text-green-900 font-semibold mb-2 flex items-center gap-2">
            <Tag className="w-4 h-4" />
            Categories
          </h3>
          <p className="text-3xl font-bold text-green-600">{categories.length}</p>
        </div>
        <div className="bg-purple-50 p-6 rounded-xl border border-purple-100">
          <h3 className="text-purple-900 font-semibold mb-2 flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Avg. Price
          </h3>
          <p className="text-3xl font-bold text-purple-600">
            ${menuItems.length > 0
              ? (menuItems.reduce((sum: number, item: { price: number | null }) => sum + (item.price || 0), 0) / menuItems.length).toFixed(2)
              : '0.00'
            }
          </p>
        </div>
      </section>
    </div>
  );
}
