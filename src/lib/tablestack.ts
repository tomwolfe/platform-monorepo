export async function getTableStackInventory(restaurantId?: string) {
  const tableStackUrl = process.env.TABLESTACK_URL || 'http://localhost:3002';
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;

  if (!internalKey) {
    throw new Error('INTERNAL_SYSTEM_KEY is not defined');
  }

  const url = new URL(`${tableStackUrl}/api/v1/external/inventory`);
  if (restaurantId) {
    url.searchParams.set('restaurantId', restaurantId);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-internal-key': internalKey,
    },
    cache: 'no-store', // All cross-app fetch calls must include cache: 'no-store' for real-time inventory.
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch inventory from TableStack: ${response.statusText}`);
  }

  return response.json();
}

export async function getTableStackRestaurant(restaurantId: string) {
  const tableStackUrl = process.env.TABLESTACK_URL || 'http://localhost:3002';
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;

  if (!internalKey) {
    throw new Error('INTERNAL_SYSTEM_KEY is not defined');
  }

  const response = await fetch(`${tableStackUrl}/api/v1/restaurant?id=${restaurantId}`, {
    method: 'GET',
    headers: {
      'x-internal-key': internalKey,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}
