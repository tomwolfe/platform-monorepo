'use client';

import { Trash2 } from 'lucide-react';
import { deleteMenuItem } from '../actions';

interface DeleteMenuItemButtonProps {
  productId: string;
  restaurantId: string;
  itemName: string;
}

export default function DeleteMenuItemButton({ 
  productId, 
  restaurantId, 
  itemName 
}: DeleteMenuItemButtonProps) {
  
  const handleDelete = async () => {
    if (confirm(`Are you sure you want to delete "${itemName}"?`)) {
      try {
        await deleteMenuItem(productId, restaurantId);
      } catch (error) {
        alert("Failed to delete item");
      }
    }
  };

  return (
    <button
      type="button"
      onClick={handleDelete}
      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
      title="Delete item"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  );
}
