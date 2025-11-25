-- Ensure createdBy is present and non-null across entities
UPDATE "Client" SET "createdBy" = '1221475' WHERE "createdBy" IS NULL;
UPDATE "Purchase" SET "createdBy" = '1221475' WHERE "createdBy" IS NULL;
UPDATE "Itinerary" SET "createdBy" = '1221475' WHERE "createdBy" IS NULL;

ALTER TABLE "Client"
  ALTER COLUMN "createdBy" SET NOT NULL;

ALTER TABLE "Purchase"
  ALTER COLUMN "createdBy" SET NOT NULL;

ALTER TABLE "Itinerary"
  ALTER COLUMN "createdBy" SET NOT NULL;

-- Add createdBy to Booking and enforce
ALTER TABLE "Booking" ADD COLUMN "createdBy" TEXT;
UPDATE "Booking" SET "createdBy" = '1221475' WHERE "createdBy" IS NULL;
ALTER TABLE "Booking" ALTER COLUMN "createdBy" SET NOT NULL;
