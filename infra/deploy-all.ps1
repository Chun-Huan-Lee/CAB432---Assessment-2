# Full deployment in dependency order. Every step is idempotent: re-run safely after fixing an error.
. "$PSScriptRoot\config.ps1"
$steps = @(
  "02-storage.ps1",
  "03-messaging.ps1",
  "04-lambdas.ps1",
  "05-api.ps1",
  "06-cognito.ps1",
  "07-schedule.ps1",
  "08-ecs.ps1",
  "09-github.ps1",
  "10-submission.ps1"
)
if (-not (Get-State).secretArn) { & "$PSScriptRoot\01-config-and-secrets.ps1" }
foreach ($step in $steps) {
  Write-Host "`n########## $step" -ForegroundColor Magenta
  & (Join-Path $PSScriptRoot $step)
}
Write-Host "`nDone. Next: .\06-cognito.ps1 -CreateUser, .\09-github.ps1 -SeedIssues, then .\12-smoke-test.ps1" -ForegroundColor Magenta
