-- A signed-in account may keep its own personal space while participating in
-- one shared household. Household membership remains explicit per selected space.
DROP INDEX IF EXISTS "HouseholdAccess_one_active_user_key";
