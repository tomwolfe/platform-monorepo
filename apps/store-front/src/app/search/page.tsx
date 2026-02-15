import { Suspense } from "react";
import { searchProducts } from "@/lib/actions";
import { SearchForm } from "@/components/search-form";
import { ReserveButton } from "@/components/reserve-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; lat?: string; lng?: string; radius?: string }>;
}) {
  const { q, lat, lng, radius } = await searchParams;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Search Products</h1>
      <SearchForm />
      
      <Suspense fallback={<div>Searching...</div>}>
        {q && lat && lng ? (
          <SearchResults 
            query={q} 
            lat={parseFloat(lat)} 
            lng={parseFloat(lng)} 
            radius={radius ? parseFloat(radius) : 10} 
          />
        ) : (
          <div className="text-center text-muted-foreground py-12">
            Enter a product name and location to start searching.
          </div>
        )}
      </Suspense>
    </div>
  );
}

async function SearchResults({ 
  query, 
  lat, 
  lng, 
  radius 
}: { 
  query: string; 
  lat: number; 
  lng: number; 
  radius: number 
}) {
  const results = await searchProducts({
    product_query: query,
    user_lat: lat,
    user_lng: lng,
    max_radius_miles: radius,
  });

  if (results.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No products found matching &quot;{query}&quot; within {radius} miles.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Results ({results.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Distance</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Available</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result) => (
              <TableRow key={`${result.store_id}-${result.product_id}`} className={result.available_quantity < 5 ? "bg-orange-50/50" : ""}>
                <TableCell className="font-medium">
                  {result.product_name}
                  {result.available_quantity < 5 && (
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                      <AlertCircle className="w-3 h-3 mr-1" />
                      Low Stock
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <div>
                    <div className="font-medium">{result.store_name}</div>
                    <div className="text-xs text-muted-foreground">{result.full_address}</div>
                  </div>
                </TableCell>
                <TableCell>{result.distance_miles} miles</TableCell>
                <TableCell>${result.price.toFixed(2)}</TableCell>
                <TableCell>
                  <span className={result.available_quantity < 5 ? "text-orange-600 font-bold" : ""}>
                    {result.available_quantity}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <ReserveButton 
                    productId={result.product_id}
                    storeId={result.store_id}
                    productName={result.product_name}
                    storeName={result.store_name}
                    maxQuantity={result.available_quantity}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
