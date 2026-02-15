/**
 * StoreFront MCP Tool Definitions
 * Standardized MCP interface for unified service mesh integration
 */

// Local type definition to avoid SDK dependency
interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const FIND_PRODUCT_NEARBY_TOOL: Tool = {
  name: "find_product_nearby",
  description: "Search for products in nearby stores based on location and product name. Returns matching products with store information, pricing, and availability.",
  inputSchema: {
    type: "object",
    properties: {
      product_query: {
        type: "string",
        description: "The product name or search query (e.g., 'organic milk', 'iPhone 15')."
      },
      user_lat: {
        type: "number",
        description: "User's current latitude coordinate."
      },
      user_lng: {
        type: "number",
        description: "User's current longitude coordinate."
      },
      max_radius_miles: {
        type: "number",
        description: "Maximum search radius in miles. Defaults to 10.",
        default: 10
      }
    },
    required: ["product_query", "user_lat", "user_lng"]
  }
};

export const RESERVE_STOCK_ITEM_TOOL: Tool = {
  name: "reserve_stock_item",
  description: "Reserve a specific quantity of a product at a store. REQUIRES CONFIRMATION. Decrements available stock immediately.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: {
        type: "string",
        description: "The unique identifier of the product to reserve."
      },
      venue_id: {
        type: "string",
        description: "The unique identifier of the store (venue) where the product is located. Maps to internal store_id."
      },
      quantity: {
        type: "number",
        description: "Number of items to reserve.",
        minimum: 1
      }
    },
    required: ["product_id", "venue_id", "quantity"]
  }
};

export const CREATE_PRODUCT_TOOL: Tool = {
  name: "create_product",
  description: "Create a new product in the system. REQUIRES CONFIRMATION. Only available for merchants.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name" },
      description: { type: "string", description: "Product description" },
      price: { type: "number", description: "Product price" },
      category: { type: "string", description: "Product category" }
    },
    required: ["name", "price", "category"]
  }
};

export const UPDATE_PRODUCT_TOOL: Tool = {
  name: "update_product",
  description: "Update an existing product. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "The ID of the product to update" },
      name: { type: "string", description: "New product name" },
      description: { type: "string", description: "New product description" },
      price: { type: "number", description: "New product price" },
      category: { type: "string", description: "New product category" }
    },
    required: ["product_id"]
  }
};

export const DELETE_PRODUCT_TOOL: Tool = {
  name: "delete_product",
  description: "Delete a product from the system. REQUIRES CONFIRMATION.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "The ID of the product to delete" }
    },
    required: ["product_id"]
  }
};

/**
 * Tool Metadata for IntentionEngine Integration
 * Defines confirmation requirements and categorization for each tool
 * 
 * Schema-first documentation based on Drizzle ORM schema:
 * 
 * Stores Table Schema:
 * - id (uuid, primary key): Unique store identifier
 * - name (text): Store display name
 * - full_address (text): Complete street address for pickup
 * - latitude (double precision): Store location latitude
 * - longitude (double precision): Store location longitude
 * - created_at (timestamp): Record creation time
 * - updated_at (timestamp): Last update time
 * 
 * Products Table Schema:
 * - id (uuid, primary key): Unique product identifier
 * - name (text): Product display name
 * - description (text): Product description
 * - price (double precision): Product price
 * - category (text): Product category
 * - created_at (timestamp): Record creation time
 * - updated_at (timestamp): Last update time
 * 
 * Stock Table Schema:
 * - id (uuid, primary key): Unique stock record identifier
 * - store_id (uuid, foreign key): Reference to stores table
 * - product_id (uuid, foreign key): Reference to products table
 * - available_quantity (integer): Current available stock count
 * - updated_at (timestamp): Last stock update time
 */
export const TOOL_METADATA = {
  find_product_nearby: {
    requires_confirmation: false,
    category: "external",
    description: "Read-only search for products in nearby stores",
    output_schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          store_id: {
            type: "string",
            format: "uuid",
            description: "Unique store identifier (from stores.id)"
          },
          venue_id: {
            type: "string",
            format: "uuid",
            description: "Cross-project standard identifier (same as store_id)"
          },
          store_name: {
            type: "string",
            description: "Store display name (from stores.name)"
          },
          product_name: {
            type: "string",
            description: "Product display name (from products.name)"
          },
          price: {
            type: "number",
            format: "double",
            description: "Product price (from products.price)"
          },
          available_quantity: {
            type: "integer",
            description: "Current stock count (from stock.available_quantity)"
          },
          distance_miles: {
            type: "string",
            description: "Distance from user location in miles"
          },
          formatted_pickup_address: {
            type: "string",
            description: "Complete address for pickup (from stores.full_address)"
          }
        }
      }
    }
  },
  reserve_stock_item: {
    requires_confirmation: true,
    category: "external",
    description: "State-changing reservation that decrements stock",
    side_effects: ["Decrements stock.available_quantity", "Creates reservation record"]
  },
  create_product: {
    requires_confirmation: true,
    category: "action",
    description: "Create a new product record"
  },
  update_product: {
    requires_confirmation: true,
    category: "action",
    description: "Update an existing product record"
  },
  delete_product: {
    requires_confirmation: true,
    category: "action",
    description: "Permanently remove a product record"
  }
};

/**
 * Parameter Mapping for Cross-Project Compatibility
 * Maps standardized venue_id to internal store_id parameter
 */
export const PARAMETER_ALIASES = {
  venue_id: "store_id",
  vendor_id: "store_id",
  shop_id: "store_id"
};
