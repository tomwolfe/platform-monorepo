'use client';

import React, { useState, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  DragEndEvent,
  DragStartEvent,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Table, Trash2, CheckCircle, AlertCircle, LucideIcon } from 'lucide-react';

interface RestaurantTable {
  id: string;
  tableNumber: string;
  minCapacity: number;
  maxCapacity: number;
  xPos: number | null;
  yPos: number | null;
  tableType: string | null;
  status: string | null;
}

interface Reservation {
  id: string;
  tableId: string | null;
  guestName: string;
  partySize: number;
  startTime: Date;
  endTime: Date;
}

interface DraggableTableProps {
  table: RestaurantTable;
  reservation?: Reservation;
}

function DraggableTable({ table, reservation }: DraggableTableProps) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: table.id,
    data: table,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    left: `${table.xPos}px`,
    top: `${table.yPos}px`,
    position: 'absolute' as const,
  };

  const getStatusColor = () => {
    if (reservation) return 'border-purple-500 bg-purple-50';
    switch (table.status) {
      case 'occupied': return 'border-red-500 bg-red-50';
      case 'dirty': return 'border-yellow-500 bg-yellow-50';
      default: return 'border-gray-200 bg-white';
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`p-4 border-2 rounded-lg shadow-md cursor-move flex flex-col items-center justify-center w-24 h-24 ${getStatusColor()} ${
        table.tableType === 'round' ? 'rounded-full' : ''
      }`}
    >
      <Table className="w-6 h-6 mb-1" />
      <span className="font-bold">#{table.tableNumber}</span>
      {reservation ? (
        <span className="text-[10px] text-purple-700 font-medium truncate w-full text-center">
          {reservation.guestName}
        </span>
      ) : (
        <span className="text-xs text-gray-500">{table.minCapacity}-{table.maxCapacity}</span>
      )}
    </div>
  );
}

function StatusZone({ id, label, icon: Icon, colorClass }: { id: string, label: string, icon: LucideIcon, colorClass: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  
  return (
    <div
      ref={setNodeRef}
      className={`flex-1 p-4 rounded-xl border-2 border-dashed flex items-center justify-center gap-2 transition-colors ${
        isOver ? colorClass : 'border-gray-200 bg-white text-gray-400'
      }`}
    >
      <Icon className="w-5 h-5" />
      <span className="font-medium">{label}</span>
    </div>
  );
}

import Ably from 'ably';
import { useRouter } from 'next/navigation';

export default function FloorPlan({ initialTables, reservations = [], onSave, onStatusChange, restaurantId }: { 
  initialTables: RestaurantTable[], 
  reservations?: Reservation[],
  onSave: (tables: RestaurantTable[]) => Promise<void>,
  onStatusChange: (tableId: string, status: 'vacant' | 'occupied' | 'dirty') => Promise<void>,
  restaurantId?: string
}) {
  const [tables, setTables] = useState(initialTables);
  const [activeTable, setActiveTable] = useState<RestaurantTable | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!restaurantId) return;

    // Use a public key or token in production. For this demo, we check if ABLY_API_KEY is available
    // but Ably.Realtime usually requires a key or token.
    // We'll skip if no key is provided to avoid crashes.
    const ably = new Ably.Realtime({ authUrl: '/api/ably/auth' }); // Better approach
    const channel = ably.channels.get(`restaurant:${restaurantId}`);
    
    channel.subscribe('NEW_RESERVATION', (message) => {
      console.log('New reservation received:', message.data);
      router.refresh(); // Refresh server component data
    });

    return () => {
      channel.unsubscribe();
      ably.close();
    };
  }, [restaurantId, router]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );

  function handleDragStart(event: DragStartEvent) {
    const { active } = event;
    setActiveTable(tables.find((t) => t.id === active.id) || null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, delta, over } = event;
    
    if (over && ['vacant', 'occupied', 'dirty'].includes(over.id as string)) {
      const newStatus = over.id as 'vacant' | 'occupied' | 'dirty';
      setTables((prev) =>
        prev.map((t) => (t.id === active.id ? { ...t, status: newStatus } : t))
      );
      onStatusChange(active.id as string, newStatus);
    } else {
      setTables((prev) =>
        prev.map((t) => {
          if (t.id === active.id) {
            return {
              ...t,
              xPos: (t.xPos || 0) + delta.x,
              yPos: (t.yPos || 0) + delta.y,
            };
          }
          return t;
        })
      );
    }
    setActiveTable(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4 mb-4">
        <StatusZone id="vacant" label="Set Vacant" icon={CheckCircle} colorClass="border-green-500 bg-green-50 text-green-700" />
        <StatusZone id="occupied" label="Set Occupied" icon={AlertCircle} colorClass="border-red-500 bg-red-50 text-red-700" />
        <StatusZone id="dirty" label="Set Dirty" icon={Trash2} colorClass="border-yellow-500 bg-yellow-50 text-yellow-700" />
      </div>

      <div className="relative w-full h-[600px] bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl overflow-hidden">
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="absolute inset-0" style={{ 
            backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)', 
            backgroundSize: '20px 20px' 
          }} />
          
          {tables.map((table) => {
            const tableReservation = reservations.find(r => r.tableId === table.id);
            return <DraggableTable key={table.id} table={table} reservation={tableReservation} />;
          })}

          <DragOverlay>
            {activeTable ? (
              <div className={`p-4 border-2 border-blue-500 rounded-lg bg-white shadow-xl flex flex-col items-center justify-center w-24 h-24 opacity-80 ${
                activeTable.tableType === 'round' ? 'rounded-full' : ''
              }`}>
                <Table className="w-6 h-6 mb-1" />
                <span className="font-bold">#{activeTable.tableNumber}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        <button
          onClick={() => onSave(tables)}
          className="absolute bottom-4 right-4 bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-blue-700 transition shadow-lg"
        >
          Save Layout
        </button>
      </div>
    </div>
  );
}
