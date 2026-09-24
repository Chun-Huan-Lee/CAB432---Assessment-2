# Builds and deploys the six Lambda functions and wires the SQS consumers.
. "$PSScriptRoot\config.ps1"
$state = Get-State
if (-not $state.secretArn) { throw "Run 01-config-and-secrets.ps1 first." }

Step "Build (esbuild)"
Push-Location $RepoRoot
try {
  if (-not (Test-Path "node_modules")) { npm ci; if ($LASTEXITCODE -ne 0) { throw "npm ci failed" } }
  node scripts/build.mjs lambdas
  if ($LASTEXITCODE -ne 0) { throw "Lambda build failed" }
} finally { Pop-Location }

$environment = Write-JsonFile "lambda-env.json" @{ Variables = @{ CONFIG_PARAMETER = $ConfigParamName; SECRET_ID = $SecretName } }

foreach ($key in $LambdaNames.Keys) {
  $name = $LambdaNames[$key]
  $timeout = $LambdaSizing[$key][0]
  $memory = $LambdaSizing[$key][1]
  Step "Lambda $name"
  $zip = Join-Path $PSScriptRoot "$key.zip"
  Compress-Archive -Path (Join-Path $RepoRoot "build/lambda/$key/index.mjs") -DestinationPath $zip -Force
  $zipUri = "fileb://" + ($zip -replace "\\", "/")

  $existing = Test-Aws lambda get-function --function-name $name
  if (-not $existing) {
    $fn = Invoke-Aws lambda create-function --function-name $name --runtime nodejs22.x --handler index.handler `
      --role $LambdaRoleArn --zip-file $zipUri --timeout $timeout --memory-size $memory `
      --environment $environment --architectures x86_64 --tags $TagsMap `
      --description "Repository Custodian: $key"
    Invoke-Aws lambda wait function-active-v2 --function-name $name | Out-Null
    Ok "Created $($fn.FunctionArn)"
  } else {
    Invoke-Aws lambda update-function-code --function-name $name --zip-file $zipUri | Out-Null
    Invoke-Aws lambda wait function-updated-v2 --function-name $name | Out-Null
    Invoke-Aws lambda update-function-configuration --function-name $name --timeout $timeout --memory-size $memory `
      --environment $environment --runtime nodejs22.x | Out-Null
    Invoke-Aws lambda wait function-updated-v2 --function-name $name | Out-Null
    Invoke-Aws lambda tag-resource --resource $existing.Configuration.FunctionArn --tags $TagsMap | Out-Null
    Ok "Updated"
  }
  $arn = (Invoke-Aws lambda get-function --function-name $name).Configuration.FunctionArn
  Set-State "lambda_$key" $arn
}

function Ensure-SqsTrigger([string] $FunctionName, [string] $QueueArn, [int] $BatchSize) {
  $mappings = Invoke-Aws lambda list-event-source-mappings --function-name $FunctionName --event-source-arn $QueueArn
  if ($mappings.EventSourceMappings.Count -gt 0) { Ok "SQS trigger already present on $FunctionName"; return }
  Invoke-Aws lambda create-event-source-mapping --function-name $FunctionName --event-source-arn $QueueArn `
    --batch-size $BatchSize --function-response-types ReportBatchItemFailures --scaling-config MaximumConcurrency=5 | Out-Null
  Ok "SQS trigger created for $FunctionName"
}

Step "SQS triggers"
$state = Get-State
Ensure-SqsTrigger $LambdaNames.worker $state.jobsQueueArn 1
Ensure-SqsTrigger $LambdaNames.indexer $state.ingestQueueArn 1
