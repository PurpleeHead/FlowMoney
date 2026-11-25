-- A signed-in account may keep its own personal space while participating in
-- one shared household. Household membership remains explicit per selected space.
DROP INDEX IF EXISTS "HouseholdAccess_one_active_user_key";

-- Keep the one-shared-household-per-account invariant at the database layer,
-- while allowing the account's separate personal OWNER access to remain active.
CREATE UNIQUE INDEX "HouseholdAccess_one_active_shared_user_key"
  ON "HouseholdAccess"("userId")
  WHERE "revokedAt" IS NULL AND "role" = 'MEMBER';
