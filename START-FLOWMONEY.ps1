$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n=== FLOWMONEY setup ===" -ForegroundColor Cyan

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker was not found. Install Docker Desktop, start it, then run this script again."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { $npm = "npm.cmd" }
  else { throw "Node.js/npm was not found. Install Node.js 20+ and reopen PowerShell." }
} else { $npm = "npm" }

# Create a local development environment file without overwriting existing settings.
$envPath = Join-Path $PSScriptRoot "server\.env"
if (-not (Test-Path $envPath)) {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $secret = [Convert]::ToBase64String($bytes)
  $rng.Dispose()
  @"
DATABASE_URL="postgresql://flowmoney:flowmoney_local@localhost:5433/flowmoney?schema=public"
JWT_SECRET="$secret"
PORT=3001
CLIENT_ORIGIN="http://localhost:5173"
TRANSLATE_URL=""
TRANSLATE_API_KEY=""
"@ | Set-Content -Path $envPath -Encoding ascii
  Write-Host "Created server/.env with a random local development JWT secret." -ForegroundColor Green
} else {
  Write-Host "Keeping existing server/.env settings." -ForegroundColor Yellow
}

Write-Host "`n[1/5] Starting PostgreSQL with Docker Compose..." -ForegroundColor Cyan
docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { throw "Docker Compose could not start PostgreSQL. Check that Docker Desktop is running." }

Write-Host "`n[2/5] Waiting for PostgreSQL..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker compose exec -T postgres pg_isready -U flowmoney -d flowmoney *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { throw "PostgreSQL did not become ready in 60 seconds. Run 'docker compose logs postgres' to inspect the error." }

Write-Host "`n[3/5] Installing npm dependencies..." -ForegroundColor Cyan
& $npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Write-Host "`n[4/5] Generating Prisma Client..." -ForegroundColor Cyan
& $npm run db:generate
if ($LASTEXITCODE -ne 0) { throw "Prisma Client generation failed. Check server/.env and dependency installation." }

Write-Host "`n[5/5] Applying database migration..." -ForegroundColor Cyan
& $npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw "Prisma migration failed. Check DATABASE_URL in server/.env and Docker PostgreSQL logs." }

Write-Host "`nStarting FLOWMONEY API and frontend. Keep this window open." -ForegroundColor Green
Write-Host "Frontend: http://localhost:5173"
Write-Host "API health: http://localhost:3001/api/health`n"
& $npm run dev
