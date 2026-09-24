# Cognito user pool for the chat front end (pre sign-up trigger = QUT emails only, auto-confirm).
. "$PSScriptRoot\config.ps1"
$state = Get-State

Step "User pool $UserPoolName"
$pool = (Invoke-Aws cognito-idp list-user-pools --max-results 60).UserPools | Where-Object { $_.Name -eq $UserPoolName } | Select-Object -First 1
if (-not $pool) {
  $settings = @{
    PoolName               = $UserPoolName
    UsernameAttributes     = @("email")
    AutoVerifiedAttributes = @("email")
    Policies               = @{ PasswordPolicy = @{ MinimumLength = 10; RequireLowercase = $true; RequireUppercase = $true; RequireNumbers = $true; RequireSymbols = $false } }
    LambdaConfig           = @{ PreSignUp = $state.lambda_presignup }
    AdminCreateUserConfig  = @{ AllowAdminCreateUserOnly = $false }
    UserPoolTags           = $TagPairs
  }
  # Reuse the SES email configuration from the Assessment 1 pool (course rule: send via noreply@cab432.com).
  $a1 = Test-Aws cognito-idp describe-user-pool --user-pool-id "ap-southeast-2_Fyeoc35D6"
  if ($a1 -and $a1.UserPool.EmailConfiguration.SourceArn) {
    $settings.EmailConfiguration = $a1.UserPool.EmailConfiguration
    Ok "Using SES email configuration from the A1 pool"
  } else { Warn "Could not copy SES email config; sign-up does not send email (auto-confirmed), so this is fine." }
  $poolInput = Write-JsonFile "cognito-pool.json" $settings
  $pool = (Invoke-Aws cognito-idp create-user-pool --cli-input-json $poolInput).UserPool
  Ok "Created $($pool.Id)"
} else { Ok "Exists $($pool.Id)" }
$poolId = $pool.Id
$poolArn = "arn:aws:cognito-idp:${Region}:${AccountId}:userpool/$poolId"

$null = Test-Aws lambda remove-permission --function-name $LambdaNames.presignup --statement-id cognito-presignup
Invoke-Aws lambda add-permission --function-name $LambdaNames.presignup --statement-id cognito-presignup `
  --action lambda:InvokeFunction --principal cognito-idp.amazonaws.com --source-arn $poolArn | Out-Null
Ok "Cognito may invoke the pre sign-up Lambda"

Step "App client $UserPoolClient (public SPA client, no secret)"
$client = (Invoke-Aws cognito-idp list-user-pool-clients --user-pool-id $poolId --max-results 60).UserPoolClients |
  Where-Object { $_.ClientName -eq $UserPoolClient } | Select-Object -First 1
if (-not $client) {
  $client = (Invoke-Aws cognito-idp create-user-pool-client --user-pool-id $poolId --client-name $UserPoolClient `
      --no-generate-secret --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH `
      --id-token-validity 60 --access-token-validity 60 --refresh-token-validity 1 `
      --token-validity-units "IdToken=minutes,AccessToken=minutes,RefreshToken=days" `
      --prevent-user-existence-errors ENABLED).UserPoolClient
  Ok "Created $($client.ClientId)"
} else { Ok "Exists $($client.ClientId)" }

Set-State "userPoolArn" $poolArn
Set-State "userPoolId" $poolId
Set-State "userPoolClientId" $client.ClientId
Update-AppConfig @{ cognitoUserPoolId = $poolId; cognitoClientId = $client.ClientId }

if ($args -contains "-CreateUser") {
  Step "Create your chat user ($QutEmail)"
  $password = Read-Host "Choose a password (10+ chars, upper, lower, number)" -MaskInput
  $attrs = Write-JsonFile "signup-attrs.json" @(@{ Name = "email"; Value = $QutEmail })
  Invoke-Aws cognito-idp sign-up --client-id $client.ClientId --username $QutEmail --password $password --user-attributes $attrs | Out-Null
  Ok "User created and auto-confirmed by the pre sign-up trigger"
}
