-- Additive personal-finance schema. Legacy exchange/receipt tables remain untouched.
ALTER TABLE "User" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow';
ALTER TABLE "User" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'ru';
ALTER TABLE "User" ADD COLUMN "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "openingBalanceDate" DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE "User" ADD COLUMN "openingBalanceConfigured" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "HouseholdMember" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "color" TEXT,
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "HouseholdMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HouseholdMember_userId_name_key" ON "HouseholdMember"("userId","name");
CREATE INDEX "HouseholdMember_userId_idx" ON "HouseholdMember"("userId");
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IncomeSource" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "memberId" TEXT, "title" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL, "recurrence" TEXT NOT NULL, "recurrenceConfig" JSONB NOT NULL,
  "startDate" DATE NOT NULL, "endDate" DATE, "isActive" BOOLEAN NOT NULL DEFAULT true, "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IncomeSource_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IncomeSource_userId_isActive_idx" ON "IncomeSource"("userId","isActive");
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "IncomeEntry" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "sourceId" TEXT, "memberId" TEXT, "plannedDate" DATE NOT NULL,
  "plannedAmount" DECIMAL(14,2) NOT NULL, "status" TEXT NOT NULL DEFAULT 'PLANNED', "actualAmount" DECIMAL(14,2),
  "receivedAt" TIMESTAMP(3), "note" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "IncomeEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IncomeEntry_sourceId_plannedDate_key" ON "IncomeEntry"("sourceId","plannedDate");
CREATE INDEX "IncomeEntry_userId_plannedDate_status_idx" ON "IncomeEntry"("userId","plannedDate","status");
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "IncomeSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IncomeEntry" ADD CONSTRAINT "IncomeEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExpenseCategory" (
  "id" TEXT NOT NULL, "userId" TEXT, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "isArchived" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExpenseCategory_userId_slug_key" ON "ExpenseCategory"("userId","slug");
CREATE INDEX "ExpenseCategory_userId_idx" ON "ExpenseCategory"("userId");
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Obligation" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "memberId" TEXT, "title" TEXT NOT NULL, "category" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL, "recurrence" TEXT NOT NULL, "recurrenceConfig" JSONB NOT NULL,
  "startDate" DATE NOT NULL, "endDate" DATE, "isActive" BOOLEAN NOT NULL DEFAULT true, "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Obligation_userId_isActive_idx" ON "Obligation"("userId","isActive");
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LedgerExpense" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "memberId" TEXT, "categoryId" TEXT, "title" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL, "date" DATE NOT NULL, "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LedgerExpense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LedgerExpense_userId_date_idx" ON "LedgerExpense"("userId","date");
CREATE INDEX "LedgerExpense_userId_categoryId_date_idx" ON "LedgerExpense"("userId","categoryId","date");
ALTER TABLE "LedgerExpense" ADD CONSTRAINT "LedgerExpense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LedgerExpense" ADD CONSTRAINT "LedgerExpense_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerExpense" ADD CONSTRAINT "LedgerExpense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ObligationOccurrence" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "obligationId" TEXT NOT NULL, "dueDate" DATE NOT NULL,
  "plannedAmount" DECIMAL(14,2) NOT NULL, "status" TEXT NOT NULL DEFAULT 'UPCOMING', "paidAt" TIMESTAMP(3),
  "actualAmount" DECIMAL(14,2), "expenseId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ObligationOccurrence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ObligationOccurrence_expenseId_key" ON "ObligationOccurrence"("expenseId");
CREATE UNIQUE INDEX "ObligationOccurrence_obligationId_dueDate_key" ON "ObligationOccurrence"("obligationId","dueDate");
CREATE INDEX "ObligationOccurrence_userId_dueDate_status_idx" ON "ObligationOccurrence"("userId","dueDate","status");
ALTER TABLE "ObligationOccurrence" ADD CONSTRAINT "ObligationOccurrence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObligationOccurrence" ADD CONSTRAINT "ObligationOccurrence_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ObligationOccurrence" ADD CONSTRAINT "ObligationOccurrence_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "LedgerExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BalanceAdjustment" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "memberId" TEXT, "amount" DECIMAL(14,2) NOT NULL,
  "date" DATE NOT NULL, "reason" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BalanceAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BalanceAdjustment_userId_date_idx" ON "BalanceAdjustment"("userId","date");
ALTER TABLE "BalanceAdjustment" ADD CONSTRAINT "BalanceAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BalanceAdjustment" ADD CONSTRAINT "BalanceAdjustment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Budget" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "memberId" TEXT, "categoryId" TEXT, "periodMonth" DATE NOT NULL,
  "limitAmount" DECIMAL(14,2) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Budget_userId_periodMonth_idx" ON "Budget"("userId","periodMonth");
-- PostgreSQL treats NULL values as distinct in ordinary unique indexes; normalize nullable scope fields.
CREATE UNIQUE INDEX "Budget_scope_unique_idx" ON "Budget" ("userId", "periodMonth", (COALESCE("memberId", '')), (COALESCE("categoryId", '')));
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SavingsGoal" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "title" TEXT NOT NULL, "targetAmount" DECIMAL(14,2) NOT NULL,
  "currentAmount" DECIMAL(14,2) NOT NULL DEFAULT 0, "targetDate" DATE, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SavingsGoal_userId_status_idx" ON "SavingsGoal"("userId","status");
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Shared default expense categories used by every household.
INSERT INTO "ExpenseCategory" ("id", "userId", "name", "slug", "isArchived", "updatedAt") VALUES
  ('system-category-groceries', NULL, 'Groceries', 'groceries', false, CURRENT_TIMESTAMP),
  ('system-category-cafes', NULL, 'Cafes & restaurants', 'cafes-restaurants', false, CURRENT_TIMESTAMP),
  ('system-category-coffee', NULL, 'Coffee', 'coffee', false, CURRENT_TIMESTAMP),
  ('system-category-transport', NULL, 'Transport & taxi', 'transport-taxi', false, CURRENT_TIMESTAMP),
  ('system-category-fuel', NULL, 'Fuel', 'fuel', false, CURRENT_TIMESTAMP),
  ('system-category-car-repair', NULL, 'Car repair', 'car-repair', false, CURRENT_TIMESTAMP),
  ('system-category-car-maintenance', NULL, 'Car maintenance', 'car-maintenance', false, CURRENT_TIMESTAMP),
  ('system-category-housing', NULL, 'Housing & home', 'housing-home', false, CURRENT_TIMESTAMP),
  ('system-category-health', NULL, 'Health', 'health', false, CURRENT_TIMESTAMP),
  ('system-category-entertainment', NULL, 'Entertainment', 'entertainment', false, CURRENT_TIMESTAMP),
  ('system-category-shopping', NULL, 'Shopping', 'shopping', false, CURRENT_TIMESTAMP),
  ('system-category-subscriptions', NULL, 'Subscriptions', 'subscriptions', false, CURRENT_TIMESTAMP),
  ('system-category-education', NULL, 'Education', 'education', false, CURRENT_TIMESTAMP),
  ('system-category-travel', NULL, 'Travel', 'travel', false, CURRENT_TIMESTAMP),
  ('system-category-other', NULL, 'Other', 'other', false, CURRENT_TIMESTAMP);
