-- CreateTable
CREATE TABLE "balance_ledger" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(18,9) NOT NULL,
    "source" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "balance_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "balance_ledger_user_id_created_at_idx" ON "balance_ledger"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "balance_ledger_created_at_idx" ON "balance_ledger"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "balance_ledger" ADD CONSTRAINT "balance_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
