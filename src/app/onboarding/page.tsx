"use client";

import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { createRestaurant } from "./actions";
import { Table as TableIcon, Plus, ChevronRight, ChevronLeft, MapPin, Clock, Settings, Save } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  DragEndEvent,
  DragStartEvent,
  useDraggable,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

const onboardingSchema = z.object({
  name: z.string().min(2, "Name is too short"),
  slug: z.string().min(2, "Slug is too short").regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens"),
  timezone: z.string().min(1, "Please select a timezone"),
  openingTime: z.string().min(1, "Please select an opening time"),
  closingTime: z.string().min(1, "Please select a closing time"),
  daysOpen: z.array(z.string()).min(1, "Please select at least one day"),
  defaultDurationMinutes: z.number().min(1),
  tables: z.array(z.object({
    id: z.string(), // Temporary ID for DnD
    tableNumber: z.string(),
    minCapacity: z.number().min(1),
    maxCapacity: z.number().min(1),
    xPos: z.number(),
    yPos: z.number(),
    tableType: z.enum(['square', 'round', 'booth']),
  })),
});

type OnboardingData = z.infer<typeof onboardingSchema>;

function DraggableTable({ table }: { table: OnboardingData['tables'][0] }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: table.id,
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
      className={`p-4 border-2 border-blue-200 bg-white rounded-lg shadow-sm cursor-move flex flex-col items-center justify-center w-24 h-24 ${
        table.tableType === 'round' ? 'rounded-full' : ''
      }`}
    >
      <TableIcon className="w-6 h-6 mb-1 text-blue-600" />
      <span className="font-bold text-sm">#{table.tableNumber}</span>
      <span className="text-[10px] text-gray-500">{table.minCapacity}-{table.maxCapacity}</span>
    </div>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<OnboardingData>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      name: "",
      slug: "",
      timezone: "UTC",
      openingTime: "17:00",
      closingTime: "22:00",
      daysOpen: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
      defaultDurationMinutes: 90,
      tables: [],
    }
  });

  const name = watch("name");
  const tables = watch("tables");
  const daysOpen = watch("daysOpen");

  const toggleDay = (day: string) => {
    if (daysOpen.includes(day)) {
      setValue("daysOpen", daysOpen.filter(d => d !== day));
    } else {
      setValue("daysOpen", [...daysOpen, day]);
    }
  };

  useEffect(() => {
    if (name && step === 1) {
      const generatedSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setValue("slug", generatedSlug);
    }
  }, [name, setValue, step]);

  const addTable = () => {
    const newTable = {
      id: Math.random().toString(36).substr(2, 9),
      tableNumber: (tables.length + 1).toString(),
      minCapacity: 2,
      maxCapacity: 4,
      xPos: 50 + (tables.length * 20) % 200,
      yPos: 50 + (Math.floor(tables.length / 10) * 100) % 400,
      tableType: 'square' as const,
    };
    setValue("tables", [...tables, newTable]);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, delta } = event;
    const updatedTables = tables.map((t) => {
      if (t.id === active.id) {
        return {
          ...t,
          xPos: Math.max(0, t.xPos + delta.x),
          yPos: Math.max(0, t.yPos + delta.y),
        };
      }
      return t;
    });
    setValue("tables", updatedTables);
  }

  const onSubmit = async (data: OnboardingData) => {
    setIsSubmitting(true);
    try {
      await createRestaurant(data);
    } catch (error) {
      console.error(error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-12 px-4">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-xl overflow-hidden">
        {/* Progress Bar */}
        <div className="bg-gray-100 h-2 w-full">
          <div 
            className="bg-blue-600 h-full transition-all duration-300" 
            style={{ width: `${(step / 3) * 100}%` }}
          />
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-8">
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Welcome to TableStack</h1>
                <p className="text-gray-500">Let's start with your restaurant's basic information.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Restaurant Name</label>
                  <input
                    {...register("name")}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="The Golden Spatula"
                  />
                  {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Public Slug</label>
                  <div className="flex items-center">
                    <span className="bg-gray-100 px-3 py-2 border border-r-0 border-gray-300 rounded-l-lg text-gray-500 text-sm">
                      tablestack.com/book/
                    </span>
                    <input
                      {...register("slug")}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-r-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                  {errors.slug && <p className="text-red-500 text-xs mt-1">{errors.slug.message}</p>}
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold flex items-center hover:bg-blue-700 transition"
                >
                  Next Step <ChevronRight className="ml-2 w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Design Your Floor Plan</h1>
                <p className="text-gray-500">Place your first few tables. You can always change this later.</p>
              </div>

              <div className="flex gap-4 mb-4">
                <button
                  type="button"
                  onClick={addTable}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 border border-blue-200 rounded-lg font-medium hover:bg-blue-100 transition"
                >
                  <Plus className="w-4 h-4" /> Add Table
                </button>
              </div>

              <div className="relative w-full h-[500px] bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl overflow-hidden">
                <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                  <div className="absolute inset-0" style={{ 
                    backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)', 
                    backgroundSize: '20px 20px' 
                  }} />
                  
                  {tables.map((table) => (
                    <DraggableTable key={table.id} table={table} />
                  ))}
                </DndContext>
                
                {tables.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                    Click "Add Table" to start building your layout
                  </div>
                )}
              </div>

              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-gray-600 px-6 py-2 rounded-lg font-semibold flex items-center hover:bg-gray-100 transition"
                >
                  <ChevronLeft className="mr-2 w-4 h-4" /> Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold flex items-center hover:bg-blue-700 transition"
                >
                  Next Step <ChevronRight className="ml-2 w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 mb-2">Final Settings</h1>
                <p className="text-gray-500">Just a few more details to get you live.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
                    <select
                      {...register("timezone")}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="UTC">UTC</option>
                      <option value="America/New_York">Eastern Time (ET)</option>
                      <option value="America/Chicago">Central Time (CT)</option>
                      <option value="America/Denver">Mountain Time (MT)</option>
                      <option value="America/Los_Angeles">Pacific Time (PT)</option>
                      <option value="Europe/London">London (GMT/BST)</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Opening Time</label>
                      <input
                        type="time"
                        {...register("openingTime")}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Closing Time</label>
                      <input
                        type="time"
                        {...register("closingTime")}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Default Duration (minutes)</label>
                    <input
                      type="number"
                      {...register("defaultDurationMinutes", { valueAsNumber: true })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Days Open</label>
                  <div className="flex flex-wrap gap-2">
                    {["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(day => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                          daysOpen.includes(day) 
                            ? "bg-blue-600 text-white" 
                            : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                        }`}
                      >
                        {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                      </button>
                    ))}
                  </div>
                  {errors.daysOpen && <p className="text-red-500 text-xs mt-1">{errors.daysOpen.message}</p>}

                  <div className="p-4 bg-blue-50 rounded-xl border border-blue-100 flex gap-4">
                    <div className="bg-blue-600 p-2 rounded-lg h-fit">
                      <Settings className="text-white w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-bold text-blue-900">Intelligent Engine Active</h3>
                      <p className="text-blue-700 text-sm text-balance">TableStack will automatically optimize your seating to maximize capacity.</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="text-gray-600 px-6 py-2 rounded-lg font-semibold flex items-center hover:bg-gray-100 transition"
                >
                  <ChevronLeft className="mr-2 w-4 h-4" /> Back
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-green-600 text-white px-8 py-2 rounded-lg font-bold flex items-center hover:bg-green-700 transition shadow-lg disabled:opacity-50"
                >
                  {isSubmitting ? "Creating..." : "Complete Setup"} <Save className="ml-2 w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
