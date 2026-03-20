'use client';

import { redirectToStoreFront } from '@/app/dashboard/[restaurantId]/actions';
import { Store } from 'lucide-react';
import { IconAfterMount } from '@/components/ui/IconWrapper';

export function UserMenu({ restaurantId }: { restaurantId?: string }) {
  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => redirectToStoreFront(restaurantId)}
        className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
      >
        <IconAfterMount>
          <Store className="w-4 h-4" />
        </IconAfterMount>
        Preview Store
      </button>
    </div>
  );
}
