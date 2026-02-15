"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reserveStock } from "@/lib/actions";
import { useToast } from "@/hooks/use-toast";

interface ReserveButtonProps {
  productId: string;
  storeId: string;
  productName: string;
  storeName: string;
  maxQuantity: number;
}

export function ReserveButton({
  productId,
  storeId,
  productName,
  storeName,
  maxQuantity,
}: ReserveButtonProps) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleReserve = async () => {
    setLoading(true);
    try {
      const result = await reserveStock({
        product_id: productId,
        store_id: storeId,
        quantity,
      });

      if (result.success) {
        toast({
          title: "Reservation Successful",
          description: `Reserved ${quantity} ${productName} at ${storeName}.`,
        });
        setOpen(false);
      } else {
        toast({
          title: "Reservation Failed",
          description: result.error,
          variant: "destructive",
        });
      }
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Reserve</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reserve {productName}</DialogTitle>
          <DialogDescription>
            at {storeName}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="quantity" className="text-right">
              Quantity
            </Label>
            <Input
              id="quantity"
              type="number"
              min={1}
              max={maxQuantity}
              value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value))}
              className="col-span-3"
            />
          </div>
          <p className="text-sm text-muted-foreground text-center">
            Max available: {maxQuantity}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={handleReserve} disabled={loading}>
            {loading ? "Reserving..." : "Confirm Reservation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
