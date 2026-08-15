# Builds the ZIP handed to the internal sales team. Launched by PACKAGE-FOR-TEAM.bat.
# This file and the .bat exclude themselves from the package they create.
#
# The package ships web\backend\.env ALREADY FILLED IN, so the team never has to paste a key.
# That is a deliberate choice for an internal audience: the alternative is five people editing
# a config file by hand, and the setup failing five different ways.
#
# Two lines are still stripped out of that .env, for reasons that are not about secrecy:
#
#   DATABASE_URL   Every instance runs the scheduler on its own 30-second timer, reading
#                  schedules from whatever store it is pointed at. Five laptops sharing one
#                  Neon database means one daily schedule fires FIVE times - five sets of real
#                  outbound calls to the same customers. Blanked, so each install keeps its own
#                  local data. Shared visibility is what deploying once is for.
#
#   ADMIN_PASSWORD Left empty on purpose so each install generates its own random admin password
#                  and prints it at first start. A password baked into a zip that is forwarded
#                  around is worse than one printed on the screen of the person using it.
param([switch]$NoCredentials)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $src

$skipDirs  = @('node_modules', 'data', 'SecretApiKey', '.git')
$skipFiles = @('PACKAGE-FOR-TEAM.bat', 'package-for-team.ps1')

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path $desktop)) { $desktop = Split-Path -Parent $src }
$suffix = if ($NoCredentials) { "-no-keys" } else { "" }
$out = Join-Path $desktop ("OmniReach-" + (Get-Date -Format 'yyyy-MM-dd') + $suffix + ".zip")

Write-Host ""
Write-Host "  Building handover package..."
if ($NoCredentials) { Write-Host "  (mode: WITHOUT credentials - the team will paste their own)" }
else { Write-Host "  (mode: WITH credentials - ready to run, nothing to fill in)" }
Write-Host ""

$stage = Join-Path $env:TEMP ('omnireach-pkg-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $stage | Out-Null
try {
  Get-ChildItem $src -Force |
    Where-Object { $skipDirs -notcontains $_.Name -and $skipFiles -notcontains $_.Name } |
    ForEach-Object { Copy-Item $_.FullName -Destination $stage -Recurse -Force }

  Get-ChildItem $stage -Recurse -Force -Directory | Where-Object { $skipDirs -contains $_.Name } | Remove-Item -Recurse -Force

  $stagedEnv = Join-Path $stage 'web\backend\.env'
  if ($NoCredentials) {
    if (Test-Path $stagedEnv) { Remove-Item $stagedEnv -Force }
  } else {
    if (-not (Test-Path $stagedEnv)) { throw "web\backend\.env not found - nothing to ship. Run with -NoCredentials instead." }
    $lines = Get-Content $stagedEnv
    $lines = $lines | ForEach-Object {
      if ($_ -match '^DATABASE_URL=')   { 'DATABASE_URL=' }
      elseif ($_ -match '^ADMIN_PASSWORD=') { 'ADMIN_PASSWORD=' }
      else { $_ }
    }
    Set-Content -Path $stagedEnv -Value $lines -Encoding ascii
    $el = ($lines | Where-Object { $_ -match '^ELEVENLABS_API_KEY=.+' }).Count
    $ag = ($lines | Where-Object { $_ -match '^ELEVENLABS_AGENT_ID=.+' }).Count
    $ph = ($lines | Where-Object { $_ -match '^ELEVENLABS_AGENT_PHONE_NUMBER_ID=.+' }).Count
    if (-not ($el -and $ag -and $ph)) { throw "The .env is missing an ElevenLabs value - the team would get a half-working install." }
    Write-Host "  [OK] .env included and ready: API key, agent id and phone id all set."
    Write-Host "  [OK] DATABASE_URL blanked   - each install keeps its own data (no duplicate scheduled calls)."
    Write-Host "  [OK] ADMIN_PASSWORD blanked - each install prints its own at first start."
  }

  foreach ($f in @('1-SETUP.bat', '2-START.bat', '3-STOP.bat', 'READ ME FIRST.txt', 'web\backend\.env.example')) {
    if (-not (Test-Path (Join-Path $stage $f))) { throw "$f is missing from the package." }
  }

  # Credential sweep. With credentials included, web\backend\.env is the ONE file allowed to hold
  # them; a key anywhere else means it leaked into source or docs and should not ship.
  $placeholder = 'user:pass|username:password|USER:PASS|your-|yourhost|example\.com|changeme|xxxx|<[^>]+>'
  $leaks = @()
  Get-ChildItem $stage -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Replace($stage, '')
    if (-not $NoCredentials -and $rel -eq '\web\backend\.env') { return }
    $hits = Select-String -Path $_.FullName -Pattern 'sk_[A-Za-z0-9]{24,}', 'postgres(ql)?://[^\s"'']+:[^\s"''@]+@' -AllMatches -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
      if ($h.Line -notmatch $placeholder) { $leaks += ($rel + '  ->  ' + $h.Line.Trim().Substring(0, [Math]::Min(70, $h.Line.Trim().Length))) }
    }
  }
  if ($leaks.Count) {
    Write-Host "  [X] STOP - a credential is somewhere it should not be:" -ForegroundColor Red
    $leaks | ForEach-Object { Write-Host ("      " + $_) -ForegroundColor Red }
    throw "Credential found outside .env; nothing was written."
  }
  Write-Host "  [OK] Swept every other file - no key anywhere it should not be."

  # Prove the database line really is blank in what ships.
  if (-not $NoCredentials) {
    $dbLine = (Get-Content $stagedEnv | Where-Object { $_ -match '^DATABASE_URL=' })
    if ($dbLine -ne 'DATABASE_URL=') { throw "DATABASE_URL was not blanked - refusing to ship." }
  }

  if (Test-Path $out) { Remove-Item $out -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -CompressionLevel Optimal

  $n  = (Get-ChildItem $stage -Recurse -File -Force).Count
  $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
  Write-Host "  [OK] $n files, $mb MB"
  Write-Host ""
  Write-Host "  ============================================================"
  Write-Host "    Package ready"
  Write-Host "  ============================================================"
  Write-Host ""
  Write-Host "    $out"
  Write-Host ""
  if ($NoCredentials) {
    Write-Host "    No credentials inside. Send the four settings separately;"
    Write-Host "    1-SETUP.bat opens Notepad for them to paste into."
  } else {
    Write-Host "    THIS ZIP CONTAINS YOUR ELEVENLABS KEY."
    Write-Host ""
    Write-Host "      - Send it on an internal channel (Teams / SharePoint / drive),"
    Write-Host "        not personal email or WhatsApp."
    Write-Host "      - Anyone with it can spend your ElevenLabs credits and place"
    Write-Host "        calls from your number. Keep the list of recipients known."
    Write-Host "      - If it ever goes astray: roll the key in ElevenLabs, then"
    Write-Host "        rebuild and resend. Nothing else needs to change."
    Write-Host ""
    Write-Host "    The team just runs 1-SETUP.bat then 2-START.bat. No keys to type."
  }
  Write-Host ""
}
finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
