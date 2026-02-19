-- OpenDeliver: Create drivers, orders, and order_items tables
-- Run this directly on your Neon database

-- Create drivers table
CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  trust_score INTEGER DEFAULT 80,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_online TIMESTAMP WITH TIME ZONE
);

-- Create indexes for drivers
CREATE UNIQUE INDEX IF NOT EXISTS drivers_clerk_id_idx ON drivers(clerk_id);
CREATE UNIQUE INDEX IF NOT EXISTS drivers_email_idx ON drivers(email);

-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  driver_id UUID REFERENCES drivers(id),
  store_id UUID REFERENCES restaurants(id),
  status TEXT NOT NULL DEFAULT 'pending',
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  delivery_address TEXT NOT NULL,
  pickup_address TEXT,
  special_instructions TEXT,
  priority TEXT DEFAULT 'standard',
  matched_at TIMESTAMP WITH TIME ZONE,
  picked_up_at TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancellation_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for orders
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_driver_id_idx ON orders(driver_id);
CREATE INDEX IF NOT EXISTS orders_store_id_idx ON orders(store_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

-- Create order_items table
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  price DOUBLE PRECISION NOT NULL,
  special_instructions TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for order_items
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
