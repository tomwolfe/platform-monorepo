-- OpenDeliver Supabase Schema

-- Drivers Table
CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  trust_score INTEGER DEFAULT 80 CHECK (trust_score >= 0 AND trust_score <= 100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_online TIMESTAMP WITH TIME ZONE
);

-- Orders Table
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES auth.users(id),
  vendor_name TEXT NOT NULL,
  pickup_address TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, matched, picking_up, delivering, completed
  payout_amount DECIMAL(10, 2) NOT NULL,
  driver_id UUID REFERENCES drivers(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  matched_at TIMESTAMP WITH TIME ZONE
);

-- Trust Score History (for auditing and calculations)
CREATE TABLE trust_score_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID REFERENCES drivers(id),
  change_amount INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS Policy for Priority Access
-- Drivers with trust_score > 90 can see 'pending' orders immediately.
-- Others can only see orders where created_at < NOW() - INTERVAL '30 seconds'.

CREATE POLICY "Priority Access for High Trust Drivers" 
ON orders FOR SELECT
USING (
  (SELECT trust_score FROM drivers WHERE id = auth.uid()) > 90
  OR 
  created_at < (NOW() - INTERVAL '30 seconds')
);
