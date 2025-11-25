-- Alter totalAmount to double precision to accept decimals
ALTER TABLE "Purchase" ALTER COLUMN "totalAmount" TYPE double precision USING "totalAmount"::double precision;
ALTER TABLE "Booking" ALTER COLUMN "totalAmount" TYPE double precision USING "totalAmount"::double precision;
