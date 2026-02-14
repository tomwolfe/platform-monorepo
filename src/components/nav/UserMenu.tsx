'use client';

import { redirectToStoreFront } from '@/app/dashboard/[restaurantId]/actions';
import { Store } from 'lucide-react';

export function UserMenu() {
  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => redirectToStoreFront()}
        className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
      >
        <Store className="w-4 h-4" />
        Preview Store
      </button>
    </div>
  );
}
