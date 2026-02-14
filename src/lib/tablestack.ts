export async function getTableStackInventory() {
  const tableStackUrl = process.env.TABLESTACK_URL || 'http://localhost:3002';
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;

  if (!internalKey) {
    throw new Error('INTERNAL_SYSTEM_KEY is not defined');
  }

  const response = await fetch(`${tableStackUrl}/api/v1/external/inventory`, {
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
