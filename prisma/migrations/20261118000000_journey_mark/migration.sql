CREATE TABLE "JourneyMark" (
    "planId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JourneyMark_pkey" PRIMARY KEY ("planId", "stopId"),
    CONSTRAINT "JourneyMark_action_check" CHECK ("action" IN ('arrived', 'skipped'))
);

CREATE UNIQUE INDEX "JourneyMark_planId_commandId_key" ON "JourneyMark"("planId", "commandId");

ALTER TABLE "JourneyMark" ADD CONSTRAINT "JourneyMark_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
