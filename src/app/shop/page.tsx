import { getTableStackInventory } from "@/lib/tablestack";
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

export const dynamic = 'force-dynamic';

interface TableStackProduct {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  availableQuantity: number;
  restaurantId: string;
}

export default async function ShopPage() {
  let products: TableStackProduct[] = [];
  let error: string | null = null;

  try {
    products = await getTableStackInventory();
  } catch (e) {
    console.error('Error loading shop data:', e);
    error = e instanceof Error ? e.message : 'Failed to load products';
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">TableStack Unified Shop</h1>
      </div>

      {error ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-8 text-center text-red-600 font-medium">
            Error: {error}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Live Inventory from TableStack</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Available</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      <div>
                        <div className="font-bold">{item.name}</div>
                        <div className="text-sm text-muted-foreground">{item.description}</div>
                      </div>
                    </TableCell>
                    <TableCell>{item.category}</TableCell>
                    <TableCell>${item.price.toFixed(2)}</TableCell>
                    <TableCell>{item.availableQuantity}</TableCell>
                    <TableCell className="text-right">
                      <ReserveButton 
                        productId={item.id}
                        storeId={item.restaurantId}
                        productName={item.name}
                        storeName="TableStack Restaurant"
                        maxQuantity={item.availableQuantity}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {products.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No products found in TableStack inventory.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
