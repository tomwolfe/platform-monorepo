import "dotenv/config";
import crypto from "node:crypto";
import {
  getDb,
  restaurants,
  restaurantTables,
  restaurantProducts,
  inventoryLevels,
  eq,
} from "@repo/database";

async function seed() {
  console.log("🌱 Seeding demo restaurant...");

  // Hash API keys before inserting — auth middleware hashes incoming keys before querying
  const plaintextApiKey = "pk_test_123456789";
  const hashedApiKey = crypto
    .createHash("sha256")
    .update(plaintextApiKey)
    .digest("hex");
  console.log(`🔑 Seeded API key (plaintext): ${plaintextApiKey}`);
  console.log(`🔐 Seeded API key (hashed):   ${hashedApiKey}`);

  const [restaurant] = await getDb()
    .insert(restaurants)
    .values({
      name: "The Pesto Place",
      slug: "demo",
      ownerEmail: "owner@pestoplace.com",
      ownerId: "user_2abc123", // Demo Clerk ID
      apiKey: hashedApiKey,
    })
    .onConflictDoUpdate({
      target: restaurants.slug,
      set: {
        name: "The Pesto Place",
        ownerEmail: "owner@pestoplace.com",
        ownerId: "user_2abc123",
        apiKey: hashedApiKey,
      },
    })
    .returning();

  console.log(
    `✅ Created/Updated restaurant: ${restaurant.name} (ID: ${restaurant.id})`,
  );

  // Clear existing tables for this restaurant to avoid duplicates
  await getDb()
    .delete(restaurantTables)
    .where(eq(restaurantTables.restaurantId, restaurant.id));

  const tables = [
    {
      tableNumber: "1",
      minCapacity: 2,
      maxCapacity: 2,
      xPos: 100,
      yPos: 100,
      tableType: "square",
    },
    {
      tableNumber: "2",
      minCapacity: 2,
      maxCapacity: 2,
      xPos: 250,
      yPos: 100,
      tableType: "square",
    },
    {
      tableNumber: "3",
      minCapacity: 4,
      maxCapacity: 4,
      xPos: 100,
      yPos: 250,
      tableType: "square",
    },
    {
      tableNumber: "4",
      minCapacity: 4,
      maxCapacity: 6,
      xPos: 250,
      yPos: 250,
      tableType: "round",
    },
    {
      tableNumber: "5",
      minCapacity: 2,
      maxCapacity: 2,
      xPos: 400,
      yPos: 100,
      tableType: "booth",
    },
  ];

  for (const table of tables) {
    await getDb()
      .insert(restaurantTables)
      .values({
        ...table,
        restaurantId: restaurant.id,
      });
  }

  console.log(`✅ Created ${tables.length} tables`);

  // Clear existing menu items and inventory for this restaurant to avoid duplicates
  await getDb()
    .delete(restaurantProducts)
    .where(eq(restaurantProducts.restaurantId, restaurant.id));

  const menuItems = [
    {
      name: "Classic Margherita Pizza",
      description:
        "Fresh tomatoes, mozzarella, basil, and extra virgin olive oil on our signature thin crust",
      price: 18.99,
      category: "Pizza",
    },
    {
      name: "Truffle Mushroom Risotto",
      description:
        "Arborio rice with wild mushrooms, black truffle oil, parmesan, and fresh herbs",
      price: 24.99,
      category: "Main Course",
    },
    {
      name: "Grilled Salmon",
      description:
        "Atlantic salmon with lemon butter sauce, served with seasonal vegetables and rice pilaf",
      price: 28.99,
      category: "Main Course",
    },
    {
      name: "Caesar Salad",
      description:
        "Crisp romaine lettuce, parmesan cheese, croutons, and our house-made Caesar dressing",
      price: 12.99,
      category: "Salads",
    },
    {
      name: "Garlic Bread",
      description:
        "Toasted ciabatta bread with garlic butter, herbs, and melted mozzarella",
      price: 8.99,
      category: "Appetizers",
    },
    {
      name: "Bruschetta",
      description:
        "Toasted bread topped with fresh tomatoes, basil, garlic, and balsamic glaze",
      price: 10.99,
      category: "Appetizers",
    },
    {
      name: "Tiramisu",
      description:
        "Classic Italian dessert with layers of coffee-soaked ladyfingers and mascarpone cream",
      price: 9.99,
      category: "Desserts",
    },
    {
      name: "Panna Cotta",
      description: "Silky vanilla custard topped with fresh berry compote",
      price: 8.99,
      category: "Desserts",
    },
    {
      name: "Italian Espresso",
      description: "Rich and bold single-origin espresso shot",
      price: 3.99,
      category: "Beverages",
    },
    {
      name: "Fresh Lemonade",
      description: "House-made lemonade with fresh mint and a hint of ginger",
      price: 5.99,
      category: "Beverages",
    },
  ];

  for (const item of menuItems) {
    const [product] = await getDb()
      .insert(restaurantProducts)
      .values({
        ...item,
        restaurantId: restaurant.id,
      })
      .returning();

    // Create inventory entry for each product
    await getDb().insert(inventoryLevels).values({
      productId: product.id,
      availableQuantity: 50, // Default stock
    });
  }

  console.log(`✅ Created ${menuItems.length} menu items with inventory`);
  console.log("🚀 Seed complete!");
}

seed().catch(console.error);
