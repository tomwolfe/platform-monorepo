"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export function SearchForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [lat, setLat] = useState(searchParams.get("lat") || "40.7128");
  const [lng, setLng] = useState(searchParams.get("lng") || "-74.0060");
  const [radius, setRadius] = useState(searchParams.get("radius") || "10");

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
          <div className="space-y-2">
            <Label htmlFor="lat">Latitude</Label>
            <Input
              id="lat"
              type="number"
              step="any"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lng">Longitude</Label>
            <Input
              id="lng"
              type="number"
              step="any"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              required
            />
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
        </form>
      </CardContent>
    </Card>
  );
}
