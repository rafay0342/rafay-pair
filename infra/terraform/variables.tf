variable "environment" {
  description = "Deployment isolation boundary."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging, or production."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "api_image" {
  description = "Immutable API image reference by sha256 digest."
  type        = string
  validation {
    condition     = can(regex("^[^[:space:]]+@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "worker_image" {
  description = "Immutable worker image reference by sha256 digest."
  type        = string
  validation {
    condition     = can(regex("^[^[:space:]]+@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "worker_image must be an immutable image reference ending in @sha256:<64 lowercase hex characters>."
  }
}

variable "certificate_arn" {
  description = "ACM certificate for the regional API load balancer."
  type        = string
}

variable "api_domain" {
  type = string
}

variable "web_domain" {
  type = string
}

variable "route53_zone_id" {
  description = "Hosted zone used for API and Web aliases."
  type        = string
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate in us-east-1 for CloudFront."
  type        = string
}

variable "runtime_secret_json" {
  description = "JSON containing separate migration/runtime database URLs, Redis, session, device-token encryption, email, Android Play Integrity server credentials, and APNs/FCM credentials. Supplied only by protected deployment automation."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition = alltrue([
      for key in [
        "MIGRATION_DATABASE_URL",
        "DATABASE_URL",
        "REDIS_URL",
        "SESSION_PEPPER",
        "EMAIL_TOKEN_PEPPER",
        "DEVICE_TOKEN_ENCRYPTION_KEY",
        "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON",
        "SMTP_URL",
        "APNS_TEAM_ID",
        "APNS_KEY_ID",
        "APNS_BUNDLE_ID",
        "APNS_PRIVATE_KEY",
        "FCM_PROJECT_ID",
        "FCM_CLIENT_EMAIL",
        "FCM_PRIVATE_KEY"
      ] : length(trimspace(try(tostring(jsondecode(var.runtime_secret_json)[key]), ""))) > 0
    ])
    error_message = "runtime_secret_json must be a JSON object containing every required non-empty Gate 1 runtime credential."
  }
}

variable "runtime_secret_version" {
  description = "Increment to rotate the write-only runtime secret without persisting its value in Terraform state."
  type        = number
  default     = 1
}

variable "play_integrity_allowed_certificate_sha256_digests" {
  description = "Unpadded base64url SHA-256 digests for every Play signing certificate allowed in this environment."
  type        = list(string)
  validation {
    condition = (
      length(var.play_integrity_allowed_certificate_sha256_digests) >= 1 &&
      length(var.play_integrity_allowed_certificate_sha256_digests) <= 8 &&
      length(distinct(var.play_integrity_allowed_certificate_sha256_digests)) == length(var.play_integrity_allowed_certificate_sha256_digests) &&
      alltrue([for digest in var.play_integrity_allowed_certificate_sha256_digests : can(regex("^[A-Za-z0-9_-]{43}$", digest))])
    )
    error_message = "play_integrity_allowed_certificate_sha256_digests must contain 1-8 unique unpadded base64url SHA-256 digests."
  }
}

variable "play_integrity_min_version_code" {
  description = "Oldest Android versionCode that may produce a low-risk Play Integrity signal."
  type        = number
  validation {
    condition     = floor(var.play_integrity_min_version_code) == var.play_integrity_min_version_code && var.play_integrity_min_version_code >= 1 && var.play_integrity_min_version_code <= 2100000000
    error_message = "play_integrity_min_version_code must be an integer from 1 through 2100000000."
  }
}

variable "app_attest_team_id" {
  description = "Apple Developer Team ID used to form the App Attest App ID. This is a public signing identifier, not a credential."
  type        = string
  validation {
    condition     = can(regex("^[A-Z0-9]{10}$", var.app_attest_team_id))
    error_message = "app_attest_team_id must be a 10-character Apple Developer Team ID."
  }
}

variable "app_attest_bundle_id" {
  description = "Registered iOS bundle identifier used to form the App Attest App ID."
  type        = string
  validation {
    condition     = length(var.app_attest_bundle_id) <= 255 && can(regex("^[A-Za-z0-9][A-Za-z0-9-]*(\\.[A-Za-z0-9][A-Za-z0-9-]*)+$", var.app_attest_bundle_id))
    error_message = "app_attest_bundle_id must be a valid reverse-DNS bundle identifier."
  }
}

variable "app_attest_allowed_validation_categories" {
  description = "Apple App Attest executable validation categories that may produce a low-risk signal."
  type        = list(number)
  validation {
    condition = (
      length(var.app_attest_allowed_validation_categories) >= 1 &&
      length(var.app_attest_allowed_validation_categories) <= 6 &&
      length(distinct(var.app_attest_allowed_validation_categories)) == length(var.app_attest_allowed_validation_categories) &&
      alltrue([for category in var.app_attest_allowed_validation_categories : floor(category) == category && category >= 1 && category <= 6])
    )
    error_message = "app_attest_allowed_validation_categories must contain unique integers from 1 through 6."
  }
}

variable "app_attest_allowed_bundle_versions" {
  description = "Explicit CFBundleVersion release window that may produce a low-risk App Attest signal."
  type        = list(string)
  validation {
    condition = (
      length(var.app_attest_allowed_bundle_versions) >= 1 &&
      length(var.app_attest_allowed_bundle_versions) <= 32 &&
      length(distinct(var.app_attest_allowed_bundle_versions)) == length(var.app_attest_allowed_bundle_versions) &&
      alltrue([for version in var.app_attest_allowed_bundle_versions : length(version) <= 64 && can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*$", version))])
    )
    error_message = "app_attest_allowed_bundle_versions must contain 1-32 unique release versions."
  }
}

variable "redis_auth_token" {
  description = "ElastiCache RBAC password (32-128 characters); supplied only by protected deployment automation and never stored in state."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = length(var.redis_auth_token) >= 32 && length(var.redis_auth_token) <= 128
    error_message = "redis_auth_token must contain 32-128 characters."
  }
}

variable "redis_auth_token_version" {
  description = "Increment to rotate the write-only ElastiCache RBAC password."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "nat_gateway_per_az" {
  type    = bool
  default = true
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}
