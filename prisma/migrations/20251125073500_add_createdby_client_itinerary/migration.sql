-- Add createdBy to Client and Itinerary for ownership tracking
ALTER TABLE "Client" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Itinerary" ADD COLUMN "createdBy" TEXT;
