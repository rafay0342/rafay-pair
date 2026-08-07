data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_ip_ranges" "cloudfront_origin_facing" {
  services = ["CLOUDFRONT_ORIGIN_FACING"]
}

locals {
  name               = "rafay-pair-${var.environment}"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  api_origin         = "https://${var.api_domain}"
  web_origin         = "https://${var.web_domain}"
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "API_HOST", value = "0.0.0.0" },
    { name = "API_PORT", value = "3000" },
    # Native tickets use the direct API origin. Browser tickets use the separate
    # CloudFront origin so WebSocket credentials and cookies stay same-origin.
    { name = "PUBLIC_API_URL", value = local.api_origin },
    { name = "PUBLIC_WEB_ORIGIN", value = local.web_origin },
    { name = "ALLOWED_ORIGINS", value = local.web_origin },
    { name = "DATABASE_CA_CERT_PATH", value = "/app/certs/aws-rds-global-bundle.pem" },
    { name = "TRUST_PROXY", value = join(",", concat([var.vpc_cidr], data.aws_ip_ranges.cloudfront_origin_facing.cidr_blocks)) },
    { name = "APNS_ENVIRONMENT", value = var.environment == "production" ? "production" : "sandbox" },
    { name = "PLAY_INTEGRITY_PACKAGE_NAME", value = var.environment == "production" ? "com.rafaypair.android" : "com.rafaypair.android.staging" },
    { name = "PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS", value = join(",", var.play_integrity_allowed_certificate_sha256_digests) },
    { name = "PLAY_INTEGRITY_MIN_VERSION_CODE", value = tostring(var.play_integrity_min_version_code) },
    { name = "PLAY_INTEGRITY_PROVIDER_TIMEOUT_MS", value = "8000" },
    { name = "PLAY_INTEGRITY_MAX_TOKEN_AGE_MS", value = "120000" },
    { name = "APP_ATTEST_TEAM_ID", value = var.app_attest_team_id },
    { name = "APP_ATTEST_BUNDLE_ID", value = var.app_attest_bundle_id },
    { name = "APP_ATTEST_ENVIRONMENT", value = var.environment == "production" ? "production" : "development" },
    { name = "APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES", value = join(",", [for category in var.app_attest_allowed_validation_categories : tostring(category)]) },
    { name = "APP_ATTEST_ALLOWED_BUNDLE_VERSIONS", value = join(",", var.app_attest_allowed_bundle_versions) },
    { name = "REALTIME_MAX_CONNECTIONS_PER_USER", value = "4" },
    { name = "REALTIME_MAX_CONNECTIONS_PER_SESSION", value = "2" },
    { name = "REALTIME_CONNECTION_LEASE_TTL_SECONDS", value = "45" },
    { name = "REALTIME_MAX_TICKETS_PER_USER_WINDOW", value = "12" },
    { name = "REALTIME_MAX_TICKETS_PER_SESSION_WINDOW", value = "6" },
    { name = "REALTIME_REPLAY_PAGE_SIZE", value = "100" },
    { name = "REALTIME_MAX_BUFFERED_EVENTS", value = "1000" },
    { name = "REALTIME_MAX_SOCKET_BUFFER_BYTES", value = "1048576" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "OBJECT_STORAGE_BUCKET", value = aws_s3_bucket.app_data.bucket },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" }
  ]
  api_secret_keys = toset([
    "DATABASE_URL",
    "REDIS_URL",
    "SESSION_PEPPER",
    "EMAIL_TOKEN_PEPPER",
    "DEVICE_TOKEN_ENCRYPTION_KEY",
    "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON",
    "SMTP_URL"
  ])
  worker_secret_keys = toset([
    "DATABASE_URL",
    "REDIS_URL",
    "SESSION_PEPPER",
    "DEVICE_TOKEN_ENCRYPTION_KEY",
    "APNS_TEAM_ID",
    "APNS_KEY_ID",
    "APNS_BUNDLE_ID",
    "APNS_PRIVATE_KEY",
    "FCM_PROJECT_ID",
    "FCM_CLIENT_EMAIL",
    "FCM_PRIVATE_KEY"
  ])
}

resource "aws_kms_key" "platform" {
  description             = "RafayPair ${var.environment} application encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableAccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowRegionalCloudWatchLogsEncryption"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:Encrypt",
          "kms:GenerateDataKey*",
          "kms:ReEncrypt*"
        ]
        Resource = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = [
              "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/rafay-pair/${var.environment}/*",
              "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/rds/instance/${local.name}/*"
            ]
          }
        }
      }
    ]
  })
}

resource "aws_kms_alias" "platform" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.platform.key_id
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${count.index + 1}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 4)
  tags              = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway_per_az ? 2 : 1
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-${count.index + 1}" }
}

resource "aws_nat_gateway" "main" {
  count         = var.nat_gateway_per_az ? 2 : 1
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.main]
  tags          = { Name = "${local.name}-nat-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[var.nat_gateway_per_az ? count.index : 0].id
  }
  tags = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_flow_log" "vpc" {
  iam_role_arn    = aws_iam_role.flow_logs.arn
  log_destination = aws_cloudwatch_log_group.vpc_flow.arn
  traffic_type    = "REJECT"
  vpc_id          = aws_vpc.main.id
}

resource "aws_cloudwatch_log_group" "vpc_flow" {
  name              = "/rafay-pair/${var.environment}/vpc-flow"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.platform.arn
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "vpc-flow-logs.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.vpc_flow.arn}:*"
    }]
  })
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS entry point"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL from application tasks only"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis from application tasks only"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  description                  = "Forward HTTPS requests only to the API container port"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "app_to_database" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "Application access to PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "app_to_redis" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.redis.id
  description                  = "Application access to Redis"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

# APNs, FCM, AWS control-plane APIs, and future approved AI endpoints publish
# changing public addresses, so an IP allowlist is not stable. Egress is limited
# to TLS and the application verifies provider hostnames and certificates.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  description       = "TLS APIs for AWS, APNs, FCM, and approved providers"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# The protected SMTP provider may use a changing public address; this rule
# permits only the implicit-TLS submission port configured by operations.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "app_smtps" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Implicit-TLS SMTP delivery"
  ip_protocol       = "tcp"
  from_port         = 465
  to_port           = 465
}

# The protected SMTP provider may use a changing public address; this rule
# permits only STARTTLS submission and never plaintext SMTP port 25.
#trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "app_smtp_submission" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  description       = "STARTTLS SMTP submission"
  ip_protocol       = "tcp"
  from_port         = 587
  to_port           = 587
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "postgres" {
  identifier                      = local.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = var.environment == "production" ? "db.m7g.large" : "db.t4g.small"
  allocated_storage               = var.environment == "production" ? 100 : 30
  max_allocated_storage           = var.environment == "production" ? 1000 : 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.platform.arn
  db_name                         = "rafay_pair"
  username                        = "rafay_pair_admin"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.platform.key_id
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  backup_retention_period         = var.environment == "production" ? 35 : 7
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = var.deletion_protection ? "${local.name}-final" : null
  multi_az                        = var.environment == "production"
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.platform.arn
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn
  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  parameter_group_name            = aws_db_parameter_group.postgres.name
  apply_immediately               = false
  depends_on                      = [aws_cloudwatch_log_group.rds]
}

resource "aws_cloudwatch_log_group" "rds" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.name}/${each.key}"
  retention_in_days = var.environment == "production" ? 365 : 30
  kms_key_id        = aws_kms_key.platform.arn
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${local.name}-postgres17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_user" "runtime" {
  user_id              = substr("${local.name}-runtime", 0, 40)
  user_name            = "default"
  engine               = "redis"
  access_string        = "on ~rafay-pair:rate-limit:* ~realtime:ticket:* ~realtime:ticket-quota:user:* ~realtime:ticket-quota:session:* ~realtime:lease:user:* ~realtime:lease:session:* &realtime:pair:*:events -@all +ping +set +getdel +eval +time +incr +pttl +zremrangebyscore +zcard +zadd +pexpire +zscore +zrem +publish +subscribe +unsubscribe +hello +client|setinfo +client|setname +quit"
  passwords_wo         = var.redis_auth_token
  passwords_wo_version = var.redis_auth_token_version
}

resource "aws_elasticache_user_group" "runtime" {
  engine        = "redis"
  user_group_id = substr("${local.name}-runtime", 0, 40)
  user_ids      = [aws_elasticache_user.runtime.user_id]
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = local.name
  description                = "RafayPair realtime transient state"
  engine                     = "redis"
  node_type                  = var.environment == "production" ? "cache.r7g.large" : "cache.t4g.small"
  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled           = var.environment == "production"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.platform.arn
  user_group_ids             = [aws_elasticache_user_group.runtime.user_group_id]
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  snapshot_retention_limit   = var.environment == "production" ? 7 : 1
  auto_minor_version_upgrade = true
}

resource "aws_s3_bucket" "app_data" {
  bucket = "${local.name}-data-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.platform.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "app_data" {
  bucket                  = aws_s3_bucket.app_data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.app_data.arn, "${aws_s3_bucket.app_data.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "app_data" {
  bucket = aws_s3_bucket.app_data.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name}/runtime"
  kms_key_id              = aws_kms_key.platform.key_id
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id                = aws_secretsmanager_secret.runtime.id
  secret_string_wo         = var.runtime_secret_json
  secret_string_wo_version = var.runtime_secret_version
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}/api"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.platform.arn
  }
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "worker" {
  name                 = "${local.name}/worker"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.platform.arn
  }
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/rafay-pair/${var.environment}/api"
  retention_in_days = var.environment == "production" ? 365 : 30
  kms_key_id        = aws_kms_key.platform.arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/rafay-pair/${var.environment}/worker"
  retention_in_days = var.environment == "production" ? 365 : 30
  kms_key_id        = aws_kms_key.platform.arn
}

resource "aws_iam_role" "ecs_execution" {
  name = "${local.name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.runtime.arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.platform.arn] }
    ]
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "ecs_task" {
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.app_data.arn, "${aws_s3_bucket.app_data.arn}/*"]
      },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"], Resource = [aws_kms_key.platform.arn] },
      {
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      }
    ]
  })
}

# Native clients require a direct public TLS API origin. The ALB accepts no
# plaintext application traffic, drops malformed headers, and is protected by
# the regional managed-rule WAF below.
#trivy:ignore:AWS-0053
resource "aws_lb" "api" {
  name                       = substr(local.name, 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true
  xff_header_processing_mode = "append"
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.name}-api", 0, 32)
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/health/ready"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_wafv2_web_acl" "api" {
  name  = "${local.name}-api"
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad"
      sampled_requests_enabled   = false
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = false
  }
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}

locals {
  api_runtime_secrets = [for key in local.api_secret_keys : {
    name      = key
    valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${key}::"
  }]
  worker_runtime_secrets = [for key in local.worker_secret_keys : {
    name      = key
    valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${key}::"
  }]
  migration_runtime_secrets = [{
    name      = "DATABASE_URL"
    valueFrom = "${aws_secretsmanager_secret.runtime.arn}:MIGRATION_DATABASE_URL::"
  }]
  otel_sidecar = {
    name      = "otel-collector"
    image     = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:27fab2ea7e9159ed5386cb60f7240883e5384a42963d45b896a271ccf8b663e5" # ADOT v0.48.0, Linux arm64.
    essential = false
    command   = ["--config=env:OTEL_CONFIG"]
    environment = [{
      name  = "OTEL_CONFIG"
      value = <<-YAML
        receivers:
          otlp:
            protocols:
              http:
                endpoint: 0.0.0.0:4318
        exporters:
          awsxray: {}
        service:
          pipelines:
            traces:
              receivers: [otlp]
              exporters: [awsxray]
      YAML
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "otel" }
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.environment == "production" ? 1024 : 512
  memory                   = var.environment == "production" ? 2048 : 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = var.api_image
      essential              = true
      readonlyRootFilesystem = true
      portMappings           = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
      environment            = local.common_environment
      secrets                = local.api_runtime_secrets
      healthCheck            = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 20 }
      linuxParameters        = { initProcessEnabled = true }
      logConfiguration = {
        logDriver = "awslogs"
        options   = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "api" }
      }
    },
    local.otel_sidecar
  ])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name                   = "migration"
    image                  = var.api_image
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "apps/api/dist/migrate.js"]
    environment            = [{ name = "NODE_ENV", value = "production" }]
    secrets                = local.migration_runtime_secrets
    linuxParameters        = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "migration" }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([
    {
      name                   = "worker"
      image                  = var.worker_image
      essential              = true
      readonlyRootFilesystem = true
      healthCheck            = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 20 }
      environment            = local.common_environment
      secrets                = local.worker_runtime_secrets
      linuxParameters        = { initProcessEnabled = true }
      logConfiguration = {
        logDriver = "awslogs"
        options   = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "worker" }
      }
    },
    merge(local.otel_sidecar, {
      logConfiguration = {
        logDriver = "awslogs"
        options   = { awslogs-group = aws_cloudwatch_log_group.worker.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "otel" }
      }
    })
  ])
}

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false
  health_check_grace_period_seconds  = 30

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = var.environment == "production" ? 20 : 4
  min_capacity       = var.api_desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}

resource "aws_route53_record" "api" {
  zone_id = var.route53_zone_id
  name    = var.api_domain
  type    = "A"
  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

resource "aws_s3_bucket" "web" {
  bucket = "${local.name}-web-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration { status = "Enabled" }
}

# This bucket contains only publicly distributed, integrity-hashed Web assets;
# sensitive application objects use the separate customer-managed KMS bucket.
# SSE-S3 avoids adding CloudFront KMS grants for deliberately public content.
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = local.name
  description                       = "Private RafayPair Web origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_function" "web_spa_rewrite" {
  name    = "${local.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Resolve extensionless Web routes without rewriting API requests"
  publish = true
  code    = <<-JAVASCRIPT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.endsWith('/') || !uri.split('/').pop().includes('.')) {
        request.uri = '/index.html';
      }
      return request;
    }
  JAVASCRIPT
}

resource "aws_cloudfront_response_headers_policy" "web" {
  name = local.name
  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${local.api_origin} wss://${var.api_domain}; media-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'"
      override                = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
    items {
      header   = "X-Robots-Tag"
      value    = var.environment == "production" ? "all" : "noindex, nofollow"
      override = true
    }
  }
}

resource "aws_wafv2_web_acl" "web" {
  provider = aws.us_east_1
  name     = "${local.name}-web"
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "web-common"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "web-known-bad"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "ViewerRateLimit"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "web-viewer-rate-limit"
      sampled_requests_enabled   = false
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-web"
    sampled_requests_enabled   = false
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  aliases             = [var.web_domain]
  default_root_object = "index.html"
  price_class         = "PriceClass_200"
  web_acl_id          = aws_wafv2_web_acl.web.arn

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }
  origin {
    domain_name = var.api_domain
    origin_id   = "api-alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    target_origin_id           = "web-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.web_spa_rewrite.arn
    }
  }
  ordered_cache_behavior {
    path_pattern               = "/v1/*"
    target_origin_id           = "api-alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    acm_certificate_arn      = var.cloudfront_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  logging_config {
    bucket          = aws_s3_bucket.web_logs.bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  depends_on = [aws_route53_record.api]
}

resource "aws_s3_bucket" "web_logs" {
  bucket = "${local.name}-web-logs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_ownership_controls" "web_logs" {
  bucket = aws_s3_bucket.web_logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_acl" "web_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.web_logs]
  bucket     = aws_s3_bucket.web_logs.id
  acl        = "log-delivery-write"
}

resource "aws_s3_bucket_public_access_block" "web_logs" {
  bucket                  = aws_s3_bucket.web_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "web_logs" {
  bucket = aws_s3_bucket.web_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.web_logs.arn, "${aws_s3_bucket.web_logs.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web_logs" {
  bucket = aws_s3_bucket.web_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web_logs" {
  bucket = aws_s3_bucket.web_logs.id
  rule {
    id     = "bounded-security-log-retention"
    status = "Enabled"
    expiration { days = 365 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOriginAccess"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.web.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
}

resource "aws_route53_record" "web" {
  zone_id = var.route53_zone_id
  name    = var.web_domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
}
