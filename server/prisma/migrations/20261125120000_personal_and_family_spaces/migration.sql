-- A signed-in account may keep its own personal space while participating in
-- one shared household. Household membership remains explicit per selected space.
DROP INDEX IF EXISTS "HouseholdAccess_one_active_user_key";

-- Restore personal OWNER access for accounts that joined a family under the old
-- single-household behavior, which revoked their original personal access.
WITH latest_revoked_owner AS (
  SELECT DISTINCT ON (access."userId") access."id"
  FROM "HouseholdAccess" access
  JOIN "Household" personal
    ON personal."id" = access."householdId"
   AND personal."ownerUserId" = access."userId"
  WHERE access."role" = 'OWNER'
    AND access."revokedAt" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "HouseholdAccess" active
      WHERE active."householdId" = personal."id"
        AND active."userId" = personal."ownerUserId"
        AND active."revokedAt" IS NULL
    )
  ORDER BY access."userId", access."joinedAt" DESC, access."id" DESC
)
UPDATE "HouseholdAccess" access
SET
  "revokedAt" = NULL,
  "memberId" = CASE
    WHEN access."memberId" IS NOT NULL AND EXISTS (
      SELECT 1
      FROM "HouseholdAccess" occupied
      WHERE occupied."householdId" = access."householdId"
        AND occupied."memberId" = access."memberId"
        AND occupied."revokedAt" IS NULL
        AND occupied."userId" <> access."userId"
    ) THEN NULL
    ELSE access."memberId"
  END
WHERE access."id" IN (SELECT "id" FROM latest_revoked_owner);

-- Defensive backfill for any account whose personal OWNER access row is missing.
INSERT INTO "HouseholdAccess" ("id", "householdId", "userId", "memberId", "role", "joinedAt")
SELECT
  'personal_access_' || md5(personal."ownerUserId"),
  personal."id",
  personal."ownerUserId",
  NULL,
  'OWNER',
  CURRENT_TIMESTAMP
FROM "Household" personal
WHERE NOT EXISTS (
  SELECT 1
  FROM "HouseholdAccess" active
  WHERE active."householdId" = personal."id"
    AND active."userId" = personal."ownerUserId"
    AND active."revokedAt" IS NULL
);

-- Keep the one-shared-household-per-account invariant at the database layer,
-- while allowing the account's separate personal OWNER access to remain active.
CREATE UNIQUE INDEX "HouseholdAccess_one_active_shared_user_key"
  ON "HouseholdAccess"("userId")
  WHERE "revokedAt" IS NULL AND "role" = 'MEMBER';
