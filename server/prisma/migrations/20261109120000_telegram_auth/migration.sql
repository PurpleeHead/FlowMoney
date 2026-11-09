ALTER TABLE "User" ADD COLUMN "telegramId" TEXT;
ALTER TABLE "User" ADD COLUMN "telegramUsername" TEXT;
ALTER TABLE "User" ADD COLUMN "telegramFirstName" TEXT;
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
