-- CreateTable
CREATE TABLE "TripEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shareId" TEXT,
    "city" TEXT,
    "day" INTEGER,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripEvent_name_createdAt_idx" ON "TripEvent"("name", "createdAt");

-- CreateIndex
CREATE INDEX "TripEvent_shareId_idx" ON "TripEvent"("shareId");

-- CreateIndex
CREATE INDEX "TripEvent_createdAt_idx" ON "TripEvent"("createdAt");

