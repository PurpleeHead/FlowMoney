param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

$envPath = Join-Path $PSScriptRoot "server\\.env"
if (-not (Test-Path $envPath)) {
  throw "server/.env was not found. Start the local setup first."
}
$databaseUrlLine = Get-Content $envPath | Where-Object { $_ -match "^\\s*DATABASE_URL=" } | Select-Object -First 1
if (-not $databaseUrlLine -or $databaseUrlLine -notmatch "localhost:5433|127\\.0\\.1:5433") {
  throw "Safety check stopped restore verification: DATABASE_URL must point to the local Docker database on port 5433."
}
if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
  throw "Backup file not found: $BackupPath"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker was not found. Start Docker Desktop and try again."
}

$containerId = (& docker compose ps -q postgres).Trim()
if ($LASTEXITCODE -ne 0 -or -not $containerId) {
  throw "The local PostgreSQL container is not running. Start it with docker compose up -d postgres."
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
$containerDump = "/tmp/flowmoney-restore-verification.dump"
$verificationDb = "flowmoney_restore_check"
$verificationStarted = $false

try {
  Write-Host "Copying the selected backup into the local PostgreSQL container..."
  & docker cp $resolvedBackup "${containerId}:$containerDump"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy the selected backup into the local container." }

  & docker compose exec -T postgres pg_restore --list $containerDump *> $null
  if ($LASTEXITCODE -ne 0) { throw "The selected file is not a readable PostgreSQL custom-format archive." }

  & docker compose exec -T postgres dropdb -U flowmoney --if-exists $verificationDb
  if ($LASTEXITCODE -ne 0) { throw "Could not clear the previous temporary verification database." }

  & docker compose exec -T postgres createdb -U flowmoney -O flowmoney $verificationDb
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary verification database." }
  $verificationStarted = $true

  Write-Host "Restoring into a disposable database (the active FlowMoney database is not changed)..."
  & docker compose exec -T postgres pg_restore -U flowmoney -d $verificationDb --no-owner --no-privileges $containerDump
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed. The temporary verification database will be removed." }

  $query = 'SELECT CASE WHEN to_regclass(''public."User"'') IS NOT NULL AND to_regclass(''public."HouseholdMember"'') IS NOT NULL AND to_regclass(''public."ObligationOccurrence"'') IS NOT NULL THEN ''RESTORE_OK'' ELSE ''RESTORE_INCOMPLETE'' END;'
  $result = (& docker compose exec -T postgres psql -U flowmoney -d $verificationDb -Atqc $query).Trim()
  if ($LASTEXITCODE -ne 0 -or $result -ne "RESTORE_OK") {
    throw "The archive restored, but required personal-finance tables were not found."
  }

  $tableCount = (& docker compose exec -T postgres psql -U flowmoney -d $verificationDb -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';").Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect the restored database." }

  Write-Host ""
  Write-Host "BACKUP RESTORE VERIFIED" -ForegroundColor Green
  Write-Host "Restored public tables: $tableCount"
  Write-Host "The test database will now be removed. The active FlowMoney database was not changed."
}
finally {
  if ($verificationStarted) {
    & docker compose exec -T postgres dropdb -U flowmoney --if-exists $verificationDb *> $null
  }
  & docker compose exec -T postgres rm -f $containerDump *> $null
}
