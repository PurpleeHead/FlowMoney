ALTER TABLE "User"
  DROP COLUMN IF EXISTS "emailVerified",
  DROP COLUMN IF EXISTS "emailVerificationTokenHash",
  DROP COLUMN IF EXISTS "emailVerificationExpiresAt";
