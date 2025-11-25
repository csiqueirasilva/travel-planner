-- Track who created the purchase for access control
ALTER TABLE "Purchase" ADD COLUMN "createdBy" TEXT;
