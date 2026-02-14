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
import { Table, Trash2, CheckCircle, AlertCircle, LucideIcon, Plus, Settings2, X, Save } from 'lucide-react';
import Ably from 'ably';
import { useRouter } from 'next/navigation';

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
  isSelected?: boolean;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  onEdit?: (table: RestaurantTable) => void;
}

function DraggableTable({ table, reservation, isSelected, onSelect, onDelete, onEdit }: DraggableTableProps) {
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
      onClick={(e) => { e.stopPropagation(); onSelect?.(table.id); }}
      className={`group p-4 border-2 rounded-lg shadow-md flex flex-col items-center justify-center w-24 h-24 cursor-pointer transition-all ${getStatusColor()} ${
        table.tableType === 'round' ? 'rounded-full' : ''
      } ${isSelected ? 'ring-4 ring-blue-500 border-blue-500' : ''}`}
    >
      <div {...listeners} {...attributes} className="cursor-move flex flex-col items-center justify-center">
        <Table className="w-6 h-6 mb-1" />
        <span className="font-bold">#{table.tableNumber}</span>
        {reservation ? (
          <span className="text-[10px] text-purple-700 font-medium truncate w-full text-center px-1">
            {reservation.guestName}
          </span>
        ) : (
          <span className="text-xs text-gray-500">{table.minCapacity}-{table.maxCapacity}</span>
        )}
      </div>

      <div className="absolute -top-2 -right-2 hidden group-hover:flex gap-1">
        <button 
          onClick={(e) => { e.stopPropagation(); onEdit?.(table); }}
          className="p-1 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700"
        >
          <Settings2 className="w-3 h-3" />
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); onDelete?.(table.id); }}
          className="p-1 bg-red-600 text-white rounded-full shadow-lg hover:bg-red-700"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function StatusZone({ 
  id, 
  label, 
  icon: Icon, 
  colorClass, 
  onClick, 
  disabled 
}: { 
  id: string, 
  label: string, 
  icon: LucideIcon, 
  colorClass: string,
  onClick?: () => void,
  disabled?: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  
  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 p-4 rounded-xl border-2 border-dashed flex items-center justify-center gap-2 transition-colors ${
        isOver ? colorClass : 
        disabled ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed' :
        'border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:bg-gray-50'
      } ${!disabled && !isOver && onClick ? 'cursor-pointer' : ''}`}
    >
      <Icon className="w-5 h-5" />
      <span className="font-medium">{label}</span>
    </button>
  );
}

export default function FloorPlan({ 
  initialTables, 
  reservations = [], 
  onSave, 
  onStatusChange,
  onAdd,
  onDelete,
  onUpdateDetails,
  restaurantId 
}: { 
  initialTables: RestaurantTable[], 
  reservations?: Reservation[],
  onSave: (tables: any[]) => Promise<void>,
  onStatusChange: (tableId: string, status: 'vacant' | 'occupied' | 'dirty') => Promise<void>,
  onAdd: () => Promise<void>,
  onDelete: (id: string) => Promise<void>,
  onUpdateDetails: (id: string, details: { tableNumber: string, minCapacity: number, maxCapacity: number }) => Promise<void>,
  restaurantId?: string
}) {
  const [tables, setTables] = useState(initialTables);
  const [activeTable, setActiveTable] = useState<RestaurantTable | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [editingTable, setEditingTable] = useState<RestaurantTable | null>(null);
  const [listMode, setListMode] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setTables(initialTables);
  }, [initialTables]);

  useEffect(() => {
    if (!restaurantId) return;

    const ably = new Ably.Realtime({ authUrl: '/api/ably/auth' });
    const channel = ably.channels.get(`restaurant:${restaurantId}`);
    
    channel.subscribe('NEW_RESERVATION', (message) => {
      console.log('New reservation received:', message.data);
      router.refresh();
    });

    channel.subscribe('RESERVATION_CANCELLED', (message) => {
      console.log('Reservation cancelled received:', message.data);
      router.refresh();
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

  const handleUpdateDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTable) return;
    await onUpdateDetails(editingTable.id, {
      tableNumber: editingTable.tableNumber,
      minCapacity: editingTable.minCapacity,
      maxCapacity: editingTable.maxCapacity,
    });
    setEditingTable(null);
  };

  const handleStatusClick = async (status: 'vacant' | 'occupied' | 'dirty') => {
    if (!selectedTableId) return;
    setTables((prev) =>
      prev.map((t) => (t.id === selectedTableId ? { ...t, status } : t))
    );
    await onStatusChange(selectedTableId, status);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between items-center mb-4">
        <div className="flex gap-4 flex-1">
          <StatusZone 
            id="vacant" 
            label="Set Vacant" 
            icon={CheckCircle} 
            colorClass="border-green-500 bg-green-50 text-green-700" 
            onClick={() => handleStatusClick('vacant')}
            disabled={!selectedTableId}
          />
          <StatusZone 
            id="occupied" 
            label="Set Occupied" 
            icon={AlertCircle} 
            colorClass="border-red-500 bg-red-50 text-red-700" 
            onClick={() => handleStatusClick('occupied')}
            disabled={!selectedTableId}
          />
          <StatusZone 
            id="dirty" 
            label="Set Dirty" 
            icon={Trash2} 
            colorClass="border-yellow-500 bg-yellow-50 text-yellow-700" 
            onClick={() => handleStatusClick('dirty')}
            disabled={!selectedTableId}
          />
          <button
            onClick={() => onAdd()}
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition"
          >
            <Plus className="w-5 h-5" /> Add Table
          </button>
        </div>
        <div className="ml-4">
          <button
            onClick={() => setListMode(!listMode)}
            className="px-4 py-2 border-2 border-gray-200 rounded-xl font-semibold hover:bg-gray-50 transition flex items-center gap-2"
          >
            <Table className="w-4 h-4" />
            {listMode ? 'Canvas Mode' : 'List Mode'}
          </button>
        </div>
      </div>

      {listMode ? (
        <div className="bg-white border-2 border-gray-100 rounded-xl overflow-hidden shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Table #</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Capacity</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {tables.map((table) => (
                <tr key={table.id} className={selectedTableId === table.id ? 'bg-blue-50' : ''} onClick={() => setSelectedTableId(table.id)}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">#{table.tableNumber}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{table.minCapacity}-{table.maxCapacity}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`px-2 py-1 text-xs font-semibold rounded-full capitalize ${
                      table.status === 'occupied' ? 'bg-red-100 text-red-700' :
                      table.status === 'dirty' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {table.status || 'vacant'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 capitalize">{table.tableType || 'square'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    <button onClick={() => setEditingTable(table)} className="text-blue-600 hover:text-blue-900"><Settings2 className="w-4 h-4" /></button>
                    <button onClick={() => onDelete(table.id)} className="text-red-600 hover:text-red-900"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div 
          className="relative w-full h-[600px] bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl overflow-hidden"
          onClick={() => setSelectedTableId(null)}
        >
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
              return (
                <DraggableTable 
                  key={table.id} 
                  table={table} 
                  reservation={tableReservation}
                  isSelected={selectedTableId === table.id}
                  onSelect={(id) => setSelectedTableId(id)}
                  onDelete={onDelete}
                  onEdit={setEditingTable}
                />
              );
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
            className="absolute bottom-4 right-4 bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-blue-700 transition shadow-lg flex items-center gap-2"
          >
            <Save className="w-4 h-4" /> Save Layout
          </button>
        </div>
      )}

      {editingTable && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold">Edit Table #{editingTable.tableNumber}</h3>
              <button onClick={() => setEditingTable(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-6 h-6" />
              </button>
            </div>
            
            <form onSubmit={handleUpdateDetails} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Table Number</label>
                <input
                  type="text"
                  value={editingTable.tableNumber}
                  onChange={(e) => setEditingTable({ ...editingTable, tableNumber: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Min Capacity</label>
                  <input
                    type="number"
                    value={editingTable.minCapacity}
                    onChange={(e) => setEditingTable({ ...editingTable, minCapacity: parseInt(e.target.value) })}
                    className="w-full px-4 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Capacity</label>
                  <input
                    type="number"
                    value={editingTable.maxCapacity}
                    onChange={(e) => setEditingTable({ ...editingTable, maxCapacity: parseInt(e.target.value) })}
                    className="w-full px-4 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition"
              >
                Save Changes
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
