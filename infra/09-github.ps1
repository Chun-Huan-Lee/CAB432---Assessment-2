# Registers the GitHub webhook (issues + push) and optionally seeds demo issues.
#   .\09-github.ps1              -> create/update webhook
#   .\09-github.ps1 -SeedIssues  -> also create the demo issues from infra/seed-issues.json
. "$PSScriptRoot\config.ps1"
$state = Get-State
if (-not $state.apiBaseUrl) { throw "Run 05-api.ps1 first." }

$secret = (Invoke-Aws secretsmanager get-secret-value --secret-id $SecretName).SecretString | ConvertFrom-Json
$headers = @{
  Authorization          = "Bearer $($secret.githubToken)"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "cab432-repository-custodian"
}
$repoApi = "https://api.github.com/repos/$GitHubOwner/$GitHubRepo"
$hookUrl = "$($state.apiBaseUrl)/webhook/github"

Step "Repository access"
$repo = Invoke-RestMethod -Uri $repoApi -Headers $headers
Ok "$($repo.full_name) (default branch $($repo.default_branch))"

Step "Webhook -> $hookUrl"
$body = @{
  name   = "web"
  active = $true
  events = @("issues", "push")
  config = @{ url = $hookUrl; content_type = "json"; secret = $secret.githubWebhookSecret; insecure_ssl = "0" }
} | ConvertTo-Json -Depth 5
$hooks = Invoke-RestMethod -Uri "$repoApi/hooks" -Headers $headers
$existing = $hooks | Where-Object { $_.config.url -eq $hookUrl } | Select-Object -First 1
if ($existing) {
  Invoke-RestMethod -Method Patch -Uri "$repoApi/hooks/$($existing.id)" -Headers $headers -Body $body -ContentType "application/json" | Out-Null
  Ok "Webhook updated (id $($existing.id))"
} else {
  $hook = Invoke-RestMethod -Method Post -Uri "$repoApi/hooks" -Headers $headers -Body $body -ContentType "application/json"
  Ok "Webhook created (id $($hook.id)); GitHub sends a ping, which should return 200"
}

if ($args -contains "-SeedIssues") {
  Step "Seeding demo issues"
  $issues = Get-Content (Join-Path $PSScriptRoot "seed-issues.json") -Raw | ConvertFrom-Json
  $open = Invoke-RestMethod -Uri "$repoApi/issues?state=all&per_page=100" -Headers $headers
  foreach ($issue in $issues) {
    if ($open | Where-Object { $_.title -eq $issue.title }) { Ok "Exists: $($issue.title)"; continue }
    $payload = @{ title = $issue.title; body = $issue.body } | ConvertTo-Json
    $created = Invoke-RestMethod -Method Post -Uri "$repoApi/issues" -Headers $headers -Body $payload -ContentType "application/json"
    Ok "#$($created.number) $($issue.title)"
    Start-Sleep -Seconds 2
  }
}
