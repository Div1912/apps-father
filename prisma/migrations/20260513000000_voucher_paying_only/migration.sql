-- Add paying_only flag to vouchers
ALTER TABLE "vouchers" ADD COLUMN "paying_only" BOOLEAN NOT NULL DEFAULT false;
