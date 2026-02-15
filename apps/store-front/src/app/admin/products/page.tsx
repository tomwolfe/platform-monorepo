import { db, storeProducts, type InferSelectModel } from "@repo/database";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { createProduct, updateProduct, deleteProduct } from "@/lib/actions/admin";
import { getAppAuth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";

export const dynamic = 'force-dynamic';

export default async function AdminProductsPage() {
  const { userId, role } = await getAppAuth();
  if (!userId) redirect("/");
  
  if (role !== "merchant") {
    // Basic check, the server actions have more robust checks
    redirect("/");
  }

  const allProducts = await db.select().from(storeProducts).orderBy(desc(storeProducts.createdAt));

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Manage Products</h1>
        <form action={async () => {
          "use server";
          await createProduct({
            name: "New Product",
            category: "General",
            price: 10.00,
            description: "New product description"
          });
        }}>
          <Button type="submit">Add Dummy Product</Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Products</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Price</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allProducts.map((product: InferSelectModel<typeof storeProducts>) => (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">{product.name}</TableCell>
                  <TableCell>{product.category}</TableCell>
                  <TableCell>${product.price.toFixed(2)}</TableCell>
                  <TableCell className="text-right space-x-2">
                    <form action={async () => {
                      "use server";
                      await deleteProduct(product.id);
                    }} className="inline">
                      <Button variant="destructive" size="sm" type="submit">Delete</Button>
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
