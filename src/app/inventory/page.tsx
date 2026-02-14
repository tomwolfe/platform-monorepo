import { getInventory } from "@/lib/actions";
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

export default async function InventoryPage() {
  const inventory = await getInventory();

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Inventory Dashboard</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Stock Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Store</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Available</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventory.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.product_name}</TableCell>
                  <TableCell>{item.category}</TableCell>
                  <TableCell>{item.store_name}</TableCell>
                  <TableCell>${item.price.toFixed(2)}</TableCell>
                  <TableCell>{item.available_quantity}</TableCell>
                  <TableCell>
                    {item.updated_at ? new Date(item.updated_at).toLocaleString() : "N/A"}
                  </TableCell>
                  <TableCell className="text-right">
                    <ReserveButton 
                      productId={item.product_id}
                      storeId={item.store_id}
                      productName={item.product_name}
                      storeName={item.store_name}
                      maxQuantity={item.available_quantity}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {inventory.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    No inventory items found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
