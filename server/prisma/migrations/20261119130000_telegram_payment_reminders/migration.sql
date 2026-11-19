ALTER TABLE "User"
  ADD COLUMN "telegramRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "telegramReminderTime" TEXT NOT NULL DEFAULT '09:00';

CREATE TABLE "TelegramReminderDelivery" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "dueDate" DATE NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramReminderDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TelegramReminderDelivery_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TelegramReminderDelivery_occurrenceId_fkey"
    FOREIGN KEY ("occurrenceId") REFERENCES "ObligationOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TelegramReminderDelivery_userId_occurrenceId_key"
  ON "TelegramReminderDelivery"("userId", "occurrenceId");
CREATE INDEX "TelegramReminderDelivery_sentAt_idx"
  ON "TelegramReminderDelivery"("sentAt");

-- Reminder delivery state contains private account and payment metadata.
ALTER TABLE "TelegramReminderDelivery" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "TelegramReminderDelivery" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "TelegramReminderDelivery" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "TelegramReminderDelivery" FROM authenticated;
  END IF;
END
$$;
