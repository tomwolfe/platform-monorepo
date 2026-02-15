import * as React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { MapPin } from "lucide-react";

interface MerchantCardProps {
  name: string;
  address: string;
  distance?: string;
  onClick?: () => void;
}

export function MerchantCard({ name, address, distance, onClick }: MerchantCardProps) {
  return (
    <Card 
      className="cursor-pointer hover:border-primary transition-colors"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{name}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p>{address}</p>
            {distance && <p className="mt-1 font-medium text-foreground">{distance} miles away</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
