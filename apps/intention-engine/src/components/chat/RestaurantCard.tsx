"use client";

import React from "react";
import { MapPin, Star } from "lucide-react";

export interface Restaurant {
  name: string;
  address: string;
  rating?: number;
  cuisine?: string;
  priceRange?: string;
  image?: string;
}

interface RestaurantCardProps {
  restaurant: Restaurant;
  onSelect: (restaurant: Restaurant) => void;
  isSelected?: boolean;
}

export const RestaurantCard: React.FC<RestaurantCardProps> = ({
  restaurant,
  onSelect,
  isSelected = false,
}) => {
  const rating = restaurant.rating ?? (4 + Math.random() * 0.5).toFixed(1);

  return (
    <div
      className={`group relative flex flex-col w-64 flex-shrink-0 rounded-xl border transition-all duration-300 overflow-hidden ${
        isSelected
          ? "border-black shadow-lg scale-[1.02]"
          : "border-slate-200 shadow-sm hover:border-slate-300 hover:shadow-md"
      }`}
    >
      {/* Image Placeholder */}
      <div className="h-32 bg-gradient-to-br from-slate-100 to-slate-200 relative overflow-hidden">
        {restaurant.image ? (
          <img
            src={restaurant.image}
            alt={restaurant.name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-slate-300">
              <svg
                className="w-12 h-12"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
            </div>
          </div>
        )}
        <div className="absolute top-2 right-2 bg-white/95 backdrop-blur-sm px-2 py-1 rounded-full shadow-sm">
          <div className="flex items-center gap-1">
            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
            <span className="text-xs font-bold text-slate-800">{rating}</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 flex flex-col">
        <div className="flex-1">
          <h4 className="font-semibold text-slate-900 text-base leading-tight mb-1 line-clamp-1">
            {restaurant.name}
          </h4>
          {restaurant.cuisine && (
            <p className="text-xs text-slate-500 mb-1">{restaurant.cuisine}</p>
          )}
          {restaurant.priceRange && (
            <p className="text-xs text-slate-500 mb-2">{restaurant.priceRange}</p>
          )}
          <div className="flex items-start gap-1.5 text-slate-400">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-500 line-clamp-2">
              {restaurant.address}
            </p>
          </div>
        </div>

        <button
          onClick={() => onSelect(restaurant)}
          className={`w-full mt-3 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
            isSelected
              ? "bg-black text-white"
              : "bg-slate-50 text-slate-700 hover:bg-black hover:text-white"
          }`}
        >
          {isSelected ? "Selected" : "Select"}
        </button>
      </div>
    </div>
  );
};
