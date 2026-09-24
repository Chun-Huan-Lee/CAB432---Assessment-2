# Cost control between work sessions.
#   .\99-pause.ps1          -> ECS service to 0 tasks, heartbeat rule disabled
#   .\99-pause.ps1 -Resume  -> back to 1 task, heartbeat enabled (new public IP!)
. "$PSScriptRoot\config.ps1"
if ($args -contains "-Resume") {
  Invoke-Aws ecs update-service --cluster $ClusterName --service $ServiceName --desired-count 1 | Out-Null
  Invoke-Aws events enable-rule --name $HeartbeatRule | Out-Null
  Ok "Resumed. Run .\08-ecs.ps1 or check the console for the new task IP."
} else {
  Invoke-Aws ecs update-service --cluster $ClusterName --service $ServiceName --desired-count 0 | Out-Null
  Invoke-Aws events disable-rule --name $HeartbeatRule | Out-Null
  Ok "Paused. Remember: the demo needs evidence of a scheduled run, so resume well before your presentation."
}
