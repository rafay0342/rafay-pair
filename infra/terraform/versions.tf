terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "RafayPair"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# CLOUDFRONT-scope WAF resources must be managed through us-east-1 even when
# the application data plane runs in another AWS region.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Application = "RafayPair"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
