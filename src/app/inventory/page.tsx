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
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const session = await auth();
  if (!session) {
    redirect("/api/auth/signin");
  }

  const { stock: stockItems, reservations: reservationItems } = await getInventory();

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Merchant Dashboard</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stock Inventory</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Available</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.product_name}</TableCell>
                  <TableCell>{item.category}</TableCell>
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
              {stockItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No inventory items found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Reservations</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservationItems.map((res) => (
                <TableRow key={res.id}>
                  <TableCell>{res.user_email}</TableCell>
                  <TableCell className="font-medium">{res.product_name}</TableCell>
                  <TableCell>{res.quantity}</TableCell>
                  <TableCell>
                    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                      res.status === 'fulfilled' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                    }`}>
                      {res.status}
                    </span>
                  </TableCell>
                  <TableCell>
                    {res.created_at ? new Date(res.created_at).toLocaleString() : "N/A"}
                  </TableCell>
                </TableRow>
              ))}
              {reservationItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    No reservations found.
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
