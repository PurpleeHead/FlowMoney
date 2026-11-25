-- A user keeps their personal OWNER access while joining one shared household as MEMBER.
-- The selected space is resolved server-side from the authenticated account and the
-- explicit ?space=personal|household selector; no client-supplied owner ID is trusted.
DROP INDEX IF EXISTS "HouseholdAccess_one_active_user_key";

-- Keep one active profile assignment per household. This prevents two accounts from
-- claiming the same household member while allowing one account to have its own
-- personal household plus one shared household membership.
CREATE UNIQUE INDEX IF NOT EXISTS "HouseholdAccess_one_active_member_key"
  ON "HouseholdAccess"("householdId", "memberId")
  WHERE "revokedAt" IS NULL AND "memberId" IS NOT NULL;
