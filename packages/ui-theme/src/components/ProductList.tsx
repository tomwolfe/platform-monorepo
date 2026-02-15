import * as React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";

interface Product {
  product_id: string;
  product_name: string;
  store_id: string;
  store_name: string;
  price: number;
  available_quantity: number;
  distance_miles?: string;
  full_address?: string;
}

interface ProductListProps {
  products: Product[];
  onReserve?: (product: Product) => void;
}

export function ProductList({ products, onReserve }: ProductListProps) {
  if (products.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No products found.
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Store</TableHead>
            <TableHead>Distance</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Available</TableHead>
            {onReserve && <TableHead className="text-right">Action</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((product) => (
            <TableRow key={`${product.store_id}-${product.product_id}`} className={product.available_quantity < 5 ? "bg-orange-50/50" : ""}>
              <TableCell className="font-medium">
                {product.product_name}
                {product.available_quantity < 5 && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                    <AlertCircle className="w-3 h-3 mr-1" />
                    Low Stock
                  </span>
                )}
              </TableCell>
              <TableCell>
                <div>
                  <div className="font-medium">{product.store_name}</div>
                  <div className="text-xs text-muted-foreground">{product.full_address}</div>
                </div>
              </TableCell>
              <TableCell>{product.distance_miles ? `${product.distance_miles} miles` : "-"}</TableCell>
              <TableCell>${product.price.toFixed(2)}</TableCell>
              <TableCell>
                <span className={product.available_quantity < 5 ? "text-orange-600 font-bold" : ""}>
                  {product.available_quantity}
                </span>
              </TableCell>
              {onReserve && (
                <TableCell className="text-right">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => onReserve(product)}
                  >
                    Reserve
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
