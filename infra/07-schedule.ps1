# EventBridge scheduled rule that runs the heartbeat Lambda with no human involved.
. "$PSScriptRoot\config.ps1"
$state = Get-State

Step "Heartbeat rule $HeartbeatRule ($HeartbeatSchedule)"
$rule = Invoke-Aws events put-rule --name $HeartbeatRule --schedule-expression $HeartbeatSchedule --state ENABLED `
  --description "Repository Custodian autonomous heartbeat" --tags $TagsList
$targets = Write-JsonFile "heartbeat-targets.json" @(@{ Id = "heartbeat-lambda"; Arn = $state.lambda_heartbeat })
Invoke-Aws events put-targets --rule $HeartbeatRule --targets $targets | Out-Null
$null = Test-Aws lambda remove-permission --function-name $LambdaNames.heartbeat --statement-id events-heartbeat
Invoke-Aws lambda add-permission --function-name $LambdaNames.heartbeat --statement-id events-heartbeat `
  --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn $rule.RuleArn | Out-Null
Set-State "heartbeatRuleArn" $rule.RuleArn
Ok "Heartbeat scheduled: $($rule.RuleArn)"
