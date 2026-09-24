# DynamoDB single table, S3 bucket (with EventBridge notifications), S3 Vectors bucket + index.
. "$PSScriptRoot\config.ps1"

Step "DynamoDB table $TableName (single-table design, on-demand)"
$table = Test-Aws dynamodb describe-table --table-name $TableName
if (-not $table) {
  $attrs = Write-JsonFile "ddb-attrs.json" @(@{ AttributeName = "PK"; AttributeType = "S" }, @{ AttributeName = "SK"; AttributeType = "S" })
  $keys  = Write-JsonFile "ddb-keys.json"  @(@{ AttributeName = "PK"; KeyType = "HASH" }, @{ AttributeName = "SK"; KeyType = "RANGE" })
  $table = Invoke-Aws dynamodb create-table --table-name $TableName --attribute-definitions $attrs `
    --key-schema $keys --billing-mode PAY_PER_REQUEST --tags $TagsList
  Invoke-Aws dynamodb wait table-exists --table-name $TableName | Out-Null
  $table = Invoke-Aws dynamodb describe-table --table-name $TableName
  Ok "Created"
} else { Ok "Exists" }
Set-State "tableArn" $table.Table.TableArn

Step "S3 bucket $BucketName"
if (-not (Test-AwsSuccess s3api head-bucket --bucket $BucketName)) {
  Invoke-Aws s3api create-bucket --bucket $BucketName --create-bucket-configuration "LocationConstraint=$Region" | Out-Null
  Ok "Created"
} else { Ok "Exists" }
# ABAC is on in the shared account: tag buckets through s3control, not put-bucket-tagging.
Invoke-Aws s3control tag-resource --account-id $AccountId --resource-arn "arn:aws:s3:::$BucketName" --tags $TagsList | Out-Null
$block = Write-JsonFile "s3-block.json" @{ BlockPublicAcls = $true; IgnorePublicAcls = $true; BlockPublicPolicy = $true; RestrictPublicBuckets = $true }
Invoke-Aws s3api put-public-access-block --bucket $BucketName --public-access-block-configuration $block | Out-Null
$encryption = Write-JsonFile "s3-enc.json" @{ Rules = @(@{ ApplyServerSideEncryptionByDefault = @{ SSEAlgorithm = "AES256" } }) }
Invoke-Aws s3api put-bucket-encryption --bucket $BucketName --server-side-encryption-configuration $encryption | Out-Null
# Send object events to EventBridge (the snapshot-created rule listens for them).
$notify = Write-JsonFile "s3-notify.json" @{ EventBridgeConfiguration = @{} }
Invoke-Aws s3api put-bucket-notification-configuration --bucket $BucketName --notification-configuration $notify | Out-Null
# Cost control: chat uploads and heartbeat reports expire, snapshots are kept only 30 days.
$lifecycle = Write-JsonFile "s3-lifecycle.json" @{ Rules = @(
    @{ ID = "expire-chat-uploads"; Status = "Enabled"; Filter = @{ Prefix = "chat-uploads/" }; Expiration = @{ Days = 30 } },
    @{ ID = "expire-snapshots"; Status = "Enabled"; Filter = @{ Prefix = "snapshots/" }; Expiration = @{ Days = 30 } }
  ) }
try { Invoke-Aws s3api put-bucket-lifecycle-configuration --bucket $BucketName --lifecycle-configuration $lifecycle | Out-Null; Ok "Lifecycle rules set" }
catch { Warn "Lifecycle rules not permitted (optional): $_" }
Set-State "bucketArn" "arn:aws:s3:::$BucketName"
Ok "Tagged, private, encrypted, EventBridge notifications on"

Step "S3 Vectors bucket $VectorBucketName / index $VectorIndexName"
$vb = Test-Aws s3vectors get-vector-bucket --vector-bucket-name $VectorBucketName
if (-not $vb) {
  Invoke-Aws s3vectors create-vector-bucket --vector-bucket-name $VectorBucketName --tags $TagsMap | Out-Null
  $vb = Invoke-Aws s3vectors get-vector-bucket --vector-bucket-name $VectorBucketName
  Ok "Vector bucket created"
} else { Ok "Vector bucket exists" }
Set-State "vectorBucketArn" $vb.vectorBucket.vectorBucketArn

$index = Test-Aws s3vectors get-index --vector-bucket-name $VectorBucketName --index-name $VectorIndexName
if (-not $index) {
  # "text" holds the chunk text: non-filterable so it can exceed the 2 KB filterable-metadata limit.
  $meta = Write-JsonFile "vec-meta.json" @{ nonFilterableMetadataKeys = @("text") }
  Invoke-Aws s3vectors create-index --vector-bucket-name $VectorBucketName --index-name $VectorIndexName `
    --data-type float32 --dimension $EmbedDims --distance-metric cosine --metadata-configuration $meta --tags $TagsMap | Out-Null
  $index = Invoke-Aws s3vectors get-index --vector-bucket-name $VectorBucketName --index-name $VectorIndexName
  Ok "Index created ($EmbedDims dims, cosine)"
} else { Ok "Index exists" }
Set-State "vectorIndexArn" $index.index.indexArn
