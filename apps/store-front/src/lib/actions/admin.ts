"use server";

import { db, storeProducts, stock, users } from "@repo/database";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getAppAuth } from "@/lib/auth";

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  category: z.string().min(1),
});

async function validateMerchant() {
  const { userId, sessionClaims, role: clerkRole } = await getAppAuth();
  if (!userId) throw new Error("Unauthorized");
  
  const [user] = await db.select().from(users).where(eq(users.clerkId, userId)).limit(1);
  
  if (!user) {
    // If user not in DB, we might want to create them, but for now we throw
    throw new Error("User not found in database");
  }

  if (clerkRole !== "merchant" && user.role !== "merchant") {
    throw new Error("Forbidden: Merchant role required");
  }
  
  return user;
}

export async function createProduct(data: z.infer<typeof productSchema>) {
  const user = await validateMerchant();
  const validated = productSchema.parse(data);

  return await db.transaction(async (tx: any) => {
    const [newProduct] = await tx.insert(storeProducts).values({
      name: validated.name,
      description: validated.description,
      price: validated.price,
      category: validated.category,
    }).returning();

    if (user.managedStoreId) {
      await tx.insert(stock).values({
        storeId: user.managedStoreId,
        productId: newProduct.id,
        availableQuantity: 0,
      });
    }

    revalidatePath("/inventory");
    revalidatePath("/admin/products");
    return newProduct;
  });
}

export async function updateProduct(id: string, data: Partial<z.infer<typeof productSchema>>) {
  await validateMerchant();
  
  const [updatedProduct] = await db.update(storeProducts)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(storeProducts.id, id))
    .returning();

  revalidatePath("/inventory");
  revalidatePath("/admin/products");
  return updatedProduct;
}

export async function deleteProduct(id: string) {
  await validateMerchant();

  await db.delete(storeProducts).where(eq(storeProducts.id, id));

  revalidatePath("/inventory");
  revalidatePath("/admin/products");
  return { success: true };
}
