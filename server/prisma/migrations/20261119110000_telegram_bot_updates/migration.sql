CREATE TABLE "TelegramBotUpdate" (
    "updateId" BIGINT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramBotUpdate_pkey" PRIMARY KEY ("updateId")
);

CREATE INDEX "TelegramBotUpdate_receivedAt_idx" ON "TelegramBotUpdate"("receivedAt");

-- Telegram webhook delivery records are backend-only idempotency keys.
ALTER TABLE "TelegramBotUpdate" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "TelegramBotUpdate" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "TelegramBotUpdate" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "TelegramBotUpdate" FROM authenticated;
  END IF;
END
$$;
