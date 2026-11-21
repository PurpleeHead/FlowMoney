param(
  [string]$BackupDirectory = (Join-Path $env:USERPROFILE "FlowMoneyBackups")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

$envPath = Join-Path $PSScriptRoot "server\.env"
if (-not (Test-Path $envPath)) {
  throw "server/.env was not found. Start the local setup first."
}
$databaseUrlLine = Get-Content $envPath | Where-Object { $_ -match "^\s*DATABASE_URL=" } | Select-Object -First 1
if (-not $databaseUrlLine -or $databaseUrlLine -notmatch "localhost:5433|127\.0\.0\.1:5433") {
  throw "Safety check stopped backup: DATABASE_URL must point to the local Docker database on port 5433."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker was not found. Start Docker Desktop and try again."
}

$containerOutput = & docker compose ps -q postgres
if ($LASTEXITCODE -ne 0) {
  throw "Could not inspect Docker Compose services."
}
$containerId = (@($containerOutput) -join "").Trim()
if (-not $containerId) {
  throw "The local PostgreSQL container is not running. Start it with docker compose up -d postgres."
}

New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$containerDump = "/tmp/flowmoney-local-$timestamp.dump"
$backupPath = Join-Path $BackupDirectory "flowmoney-local-$timestamp.dump"

try {
  Write-Host "Creating a local PostgreSQL custom-format backup..."
  & docker compose exec -T postgres pg_dump -U flowmoney -d flowmoney -Fc -f $containerDump
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed. No backup was copied." }

  & docker cp "${containerId}:$containerDump" $backupPath
  if ($LASTEXITCODE -ne 0) { throw "Could not copy the backup from the local database container." }

  if (-not (Test-Path $backupPath) -or (Get-Item $backupPath).Length -lt 100) {
    throw "The backup file is missing or unexpectedly small."
  }

  & docker compose exec -T postgres pg_restore --list $containerDump *> $null
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL could not read the generated backup archive." }

  Write-Host ""
  Write-Host "Local backup created and archive-checked:" -ForegroundColor Green
  Write-Host $backupPath
  Write-Host "This script did not change the database or run migrations."
}
finally {
  & docker compose exec -T postgres rm -f $containerDump *> $null
}
