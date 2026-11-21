CREATE TABLE "Household" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Моя семья',
  "ownerUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HouseholdAccess" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memberId" TEXT,
  "role" TEXT NOT NULL DEFAULT 'MEMBER',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "HouseholdAccess_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HouseholdInvite" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HouseholdInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Household_ownerUserId_key" ON "Household"("ownerUserId");
CREATE UNIQUE INDEX "HouseholdInvite_tokenHash_key" ON "HouseholdInvite"("tokenHash");
CREATE INDEX "Household_ownerUserId_idx" ON "Household"("ownerUserId");
CREATE INDEX "HouseholdAccess_userId_revokedAt_idx" ON "HouseholdAccess"("userId", "revokedAt");
CREATE INDEX "HouseholdAccess_householdId_revokedAt_idx" ON "HouseholdAccess"("householdId", "revokedAt");
CREATE INDEX "HouseholdAccess_memberId_idx" ON "HouseholdAccess"("memberId");
CREATE INDEX "HouseholdInvite_householdId_createdAt_idx" ON "HouseholdInvite"("householdId", "createdAt");
CREATE INDEX "HouseholdInvite_createdByUserId_createdAt_idx" ON "HouseholdInvite"("createdByUserId", "createdAt");
CREATE INDEX "HouseholdInvite_expiresAt_acceptedAt_revokedAt_idx" ON "HouseholdInvite"("expiresAt", "acceptedAt", "revokedAt");

ALTER TABLE "Household" ADD CONSTRAINT "Household_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdAccess" ADD CONSTRAINT "HouseholdAccess_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdAccess" ADD CONSTRAINT "HouseholdAccess_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdAccess" ADD CONSTRAINT "HouseholdAccess_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing account gets a personal household without moving or rewriting financial rows.
INSERT INTO "Household" ("id", "name", "ownerUserId", "createdAt", "updatedAt")
SELECT 'household_' || md5("id"), 'Моя семья', "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User";

INSERT INTO "HouseholdAccess" ("id", "householdId", "userId", "memberId", "role", "joinedAt")
SELECT 'access_' || md5(u."id"), h."id", u."id", NULL, 'OWNER', CURRENT_TIMESTAMP
FROM "User" u
JOIN "Household" h ON h."ownerUserId" = u."id";

-- A user can belong to only one active household. A member profile can be assigned to only one active account.
CREATE UNIQUE INDEX "HouseholdAccess_one_active_user_key"
  ON "HouseholdAccess"("userId") WHERE "revokedAt" IS NULL;
CREATE UNIQUE INDEX "HouseholdAccess_one_active_member_key"
  ON "HouseholdAccess"("householdId", "memberId")
  WHERE "revokedAt" IS NULL AND "memberId" IS NOT NULL;
