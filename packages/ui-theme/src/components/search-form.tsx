"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Loader2, Search } from "lucide-react";

/**
 * Photon API autocomplete result
 */
interface PhotonSuggestion {
  lat: number;
  lon: number;
  name?: string;
  street?: string;
  city?: string;
  postcode?: string;
  country?: string;
  state?: string;
  displayName?: string;
}

export function SearchForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [lat, setLat] = useState(searchParams.get("lat") || "40.7128");
  const [lng, setLng] = useState(searchParams.get("lng") || "-74.0060");
  const [radius, setRadius] = useState(searchParams.get("radius") || "10");
  const [isLocating, setIsLocating] = useState(false);
  
  // Photon autocomplete state
  const [searchInput, setSearchInput] = useState("");
  const [suggestions, setSuggestions] = useState<PhotonSuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  /**
   * Fetch location suggestions from Photon API
   */
  const fetchSuggestions = async (input: string) => {
    if (input.length < 2) {
      setSuggestions([]);
      return;
    }

    setIsSearching(true);
    try {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(input)}&limit=5`;
      const res = await fetch(url);
      const data = await res.json();
      
      const results: PhotonSuggestion[] = (data.features || []).map((f: any) => ({
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        name: f.properties.name,
        street: f.properties.street,
        city: f.properties.city,
        postcode: f.properties.postcode,
        country: f.properties.country,
        state: f.properties.state,
        displayName: [
          f.properties.name,
          f.properties.street,
          f.properties.city,
          f.properties.state,
          f.properties.country
        ].filter(Boolean).join(", "),
      }));
      
      setSuggestions(results);
    } catch (err) {
      console.error("Photon autocomplete error:", err);
      setSuggestions([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput) {
        fetchSuggestions(searchInput);
      } else {
        setSuggestions([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput]);

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectSuggestion = (suggestion: PhotonSuggestion) => {
    setLat(suggestion.lat.toString());
    setLng(suggestion.lon.toString());
    setSearchInput(suggestion.displayName || "");
    setShowSuggestions(false);
    setSuggestions([]);
  };

  const handleGeolocation = () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser");
      return;
    }

    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toString());
        setLng(position.coords.longitude.toString());
        setIsLocating(false);
      },
      (error) => {
        console.error("Error getting location:", error);
        setIsLocating(false);
        alert("Unable to retrieve your location");
      }
    );
  };

  useEffect(() => {
    // Only auto-locate if lat/lng are at defaults and not provided in searchParams
    if (!searchParams.get("lat") && !searchParams.get("lng") && lat === "40.7128" && lng === "-74.0060") {
      handleGeolocation();
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("lat", lat);
    params.set("lng", lng);
    params.set("radius", radius);
    router.push(`/search?${params.toString()}`);
  };

  return (
    <Card className="mb-8">
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div className="space-y-2">
            <Label htmlFor="q">Product Name</Label>
            <Input
              id="q"
              placeholder="e.g. Apple"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              required
            />
          </div>
          
          <div className="space-y-2 md:col-span-2 relative" ref={suggestionsRef}>
            <div className="flex justify-between items-center">
              <Label htmlFor="location">Location</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={handleGeolocation}
                disabled={isLocating}
              >
                {isLocating ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <MapPin className="h-3 w-3 mr-1" />}
                Use Current Location
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="location"
                placeholder="Search for a city, address, or place..."
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                className="pl-9"
              />
              {isSearching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>
            
            {/* Autocomplete Suggestions */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute z-50 w-full mt-1 bg-background border rounded-md shadow-lg max-h-60 overflow-auto">
                {suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-accent hover:text-accent-foreground text-sm"
                    onClick={() => handleSelectSuggestion(suggestion)}
                  >
                    <div className="font-medium">{suggestion.name || suggestion.street}</div>
                    <div className="text-xs text-muted-foreground">
                      {[suggestion.city, suggestion.state, suggestion.country].filter(Boolean).join(", ")}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="radius">Radius (miles)</Label>
            <div className="flex gap-2">
              <Input
                id="radius"
                type="number"
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
                required
              />
              <Button type="submit">Search</Button>
            </div>
          </div>
          
          {/* Hidden fields for lat/lng (used by form submission) */}
          <input type="hidden" id="lat" value={lat} />
          <input type="hidden" id="lng" value={lng} />
        </form>
      </CardContent>
    </Card>
  );
}
