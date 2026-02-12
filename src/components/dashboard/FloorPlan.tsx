'use client';

import React, { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  DragEndEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Table } from 'lucide-react';

interface RestaurantTable {
  id: string;
  tableNumber: string;
  minCapacity: number;
  maxCapacity: number;
  xPos: number | null;
  yPos: number | null;
  tableType: string | null;
}

interface DraggableTableProps {
  table: RestaurantTable;
}

function DraggableTable({ table }: DraggableTableProps) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`p-4 border-2 rounded-lg bg-white shadow-md cursor-move flex flex-col items-center justify-center w-24 h-24 ${
        table.tableType === 'round' ? 'rounded-full' : ''
      }`}
    >
      <Table className="w-6 h-6 mb-1" />
      <span className="font-bold">#{table.tableNumber}</span>
      <span className="text-xs text-gray-500">{table.minCapacity}-{table.maxCapacity}</span>
    </div>
  );
}

export default function FloorPlan({ initialTables, onSave }: { initialTables: RestaurantTable[], onSave: (tables: RestaurantTable[]) => Promise<void> }) {
  const [tables, setTables] = useState(initialTables);
  const [activeTable, setActiveTable] = useState<RestaurantTable | null>(null);

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
    const { active, delta } = event;
    
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
    setActiveTable(null);
  }

  return (
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
        
        {tables.map((table) => (
          <DraggableTable key={table.id} table={table} />
        ))}

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
  );
}
