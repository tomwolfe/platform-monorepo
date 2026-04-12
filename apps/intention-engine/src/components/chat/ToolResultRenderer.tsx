"use client";

import React from "react";
import {
  MapPin,
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Restaurant, RestaurantCard } from "./RestaurantCard";
import type { ToolUIPart } from "ai";

/**
 * Represents the output of a tool execution.
 * This is a simplified runtime shape that matches what our tools return.
 */
interface ToolOutput {
  success: boolean;
  result?: Record<string, unknown> | unknown[];
  error?: string;
  download_url?: string;
  event_details?: {
    title: string;
    start_time: string;
    end_time?: string;
    location?: string;
  };
  lat?: number;
  lon?: number;
}

interface ToolResultRendererProps {
  toolName: string;
  toolInvocation: ToolUIPart;
  onRestaurantSelect?: (restaurant: Restaurant) => void;
}

export const ToolResultRenderer: React.FC<ToolResultRendererProps> = ({
  toolName,
  toolInvocation,
  onRestaurantSelect,
}) => {
  // Handle loading/streaming state
  if (toolInvocation.state === "input-streaming") {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Loader2 size={14} className="animate-spin" />
        <span>Working on it...</span>
      </div>
    );
  }

  // Handle error state - show conversational message
  if (toolInvocation.state === "output-error") {
    return (
      <div className="bg-red-50 border border-red-100 rounded-lg p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-800 font-medium">
              Something went wrong
            </p>
            <p className="text-xs text-red-600 mt-1">
              Let me try a different approach or adjust the parameters.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Handle success state
  if (toolInvocation.state === "output-available") {
    const output = toolInvocation.output as ToolOutput;

    // Geocode Location
    if (toolName === "geocode_location") {
      if (
        output.success &&
        output.result &&
        typeof output.result === "object" &&
        "lat" in output.result &&
        "lon" in output.result
      ) {
        return (
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
            <div className="flex items-center gap-3">
              <div className="bg-blue-100 p-2.5 rounded-full text-blue-600">
                <MapPin size={20} />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Location Found
                </p>
                <p className="text-xs text-slate-500">
                  {(output.result as any).lat.toFixed(4)},{" "}
                  {(output.result as any).lon.toFixed(4)}
                </p>
              </div>
            </div>
          </div>
        );
      }
    }

    // Search Restaurant
    if (toolName === "search_restaurant") {
      if (output.success && Array.isArray(output.result)) {
        if (output.result.length === 0) {
          return (
            <div className="text-sm text-slate-500 italic py-2">
              No restaurants found matching your criteria. Let me try a broader
              search.
            </div>
          );
        }

        const restaurants: Restaurant[] = (
          output.result as Array<Record<string, unknown>>
        ).map((r) => ({
          name: String(r.name ?? ""),
          address: String(r.address ?? ""),
          rating: Number(r.rating ?? 0),
          cuisine: String(r.cuisine ?? ""),
          priceRange: String(r.price_range ?? ""),
          image: String(r.image_url ?? ""),
        }));

        return (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              I found {restaurants.length} great options for you:
            </p>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
              {restaurants.map((restaurant, i) => (
                <RestaurantCard
                  key={i}
                  restaurant={restaurant}
                  onSelect={(r) => {
                    if (onRestaurantSelect) {
                      onRestaurantSelect(r);
                    }
                  }}
                />
              ))}
            </div>
          </div>
        );
      }
    }

    // Add Calendar Event
    if (toolName === "add_calendar_event") {
      const resultObj = output.result as Record<string, unknown> | undefined;
      if (output.success && resultObj?.download_url) {
        const details = resultObj.event_details as
          | Record<string, unknown>
          | undefined;
        return (
          <div className="bg-green-50 border border-green-100 rounded-lg p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="bg-white p-2 rounded-lg border border-green-200 text-green-600 shadow-sm">
                <Calendar size={20} />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-green-900">
                  Event Ready to Schedule
                </p>
                <p className="text-xs text-green-700 mt-0.5">
                  Your calendar invite is ready to download.
                </p>
              </div>
            </div>

            {details && (
              <div className="bg-white/60 backdrop-blur-sm rounded-lg p-3 mb-3 space-y-2">
                <p className="text-sm font-semibold text-slate-900">
                  {String(details.title ?? "")}
                </p>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <Calendar size={12} />
                    <span>
                      {new Date(
                        String(details.start_time ?? ""),
                      ).toLocaleString()}
                    </span>
                  </div>
                  {Boolean(details.location) && (
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <MapPin size={12} />
                      <span>{String(details.location)}</span>
                    </div>
                  )}
                  {Boolean(details.end_time) && (
                    <div className="flex items-center gap-2 text-xs text-slate-600">
                      <Clock size={12} />
                      <span>
                        {new Date(
                          String(details.end_time ?? ""),
                        ).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <a
              href={String(resultObj?.download_url ?? "#")}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors shadow-sm"
            >
              <Calendar size={16} />
              Download Calendar Event
            </a>
          </div>
        );
      }
    }

    // Generic tool output - show simplified summary instead of raw JSON
    return (
      <div className="text-sm text-slate-600">
        <p>
          I&apos;ve completed that task. Let me know if you need more details.
        </p>
      </div>
    );
  }

  return null;
};
