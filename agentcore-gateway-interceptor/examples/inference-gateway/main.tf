provider "aws" {
  region = var.region
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  partition     = data.aws_partition.current.partition
  account_id    = data.aws_caller_identity.current.account_id
  create_role   = var.existing_gateway_role_name == ""
  role_name     = local.create_role ? aws_iam_role.gateway[0].name : var.existing_gateway_role_name
  role_arn      = local.create_role ? aws_iam_role.gateway[0].arn : data.aws_iam_role.existing[0].arn
  inference_url = "${trimsuffix(trimsuffix(aws_bedrockagentcore_gateway.this.gateway_url, "/"), "/mcp")}/inference"
  all_model_arns = [
    "arn:${local.partition}:bedrock:*::foundation-model/*",
    "arn:${local.partition}:bedrock:*:${local.account_id}:inference-profile/*",
    "arn:${local.partition}:bedrock:*:${local.account_id}:application-inference-profile/*",
    "arn:${local.partition}:bedrock:*:${local.account_id}:provisioned-model/*",
    "arn:${local.partition}:bedrock:*:${local.account_id}:custom-model-deployment/*",
    "arn:${local.partition}:bedrock:*:${local.account_id}:imported-model/*",
  ]
  invoke_resource_arns = length(var.invoke_model_resource_arns) > 0 ? var.invoke_model_resource_arns : local.all_model_arns
}

module "interceptor" {
  source = "../../terraform"

  function_name                 = "${var.name}-interceptor"
  langguard_url                 = var.langguard_url
  langguard_api_key_secret_arn  = var.langguard_api_key_secret_arn
  gateway_authorizer_type       = var.authorizer_type
  gateway_kind                  = "inference"
  user_claim                    = var.user_claim
  sts_key_map_enabled           = var.sts_key_map_enabled
  secret_kms_key_arn            = var.secret_kms_key_arn
  role_permissions_boundary_arn = var.role_permissions_boundary_arn
  subnet_ids                    = var.subnet_ids
  security_group_ids            = var.security_group_ids
}

data "aws_iam_policy_document" "gateway_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:bedrock-agentcore:${var.region}:${local.account_id}:gateway/*"]
    }
  }
}

resource "aws_iam_role" "gateway" {
  count              = local.create_role ? 1 : 0
  name               = "${var.name}-gateway"
  assume_role_policy = data.aws_iam_policy_document.gateway_assume.json
}

data "aws_iam_role" "existing" {
  count = local.create_role ? 0 : 1
  name  = var.existing_gateway_role_name
}

# Target creation scans the Amazon Bedrock model catalog as the gateway role. A denied list call stops the
# target before it is Ready, so the role gets the full list set of the bedrock-runtime connector.
data "aws_iam_policy_document" "gateway" {
  statement {
    sid       = "InvokeInterceptor"
    actions   = ["lambda:InvokeFunction"]
    resources = [module.interceptor.function_arn]
  }

  statement {
    sid = "DiscoverModels"
    actions = [
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
      "bedrock:ListProvisionedModelThroughputs",
      "bedrock:ListCustomModelDeployments",
      "bedrock:ListImportedModels",
      "bedrock:ListMarketplaceModelEndpoints",
      "bedrock:ListPromptRouters",
      "bedrock:GetFoundationModel",
      "bedrock:GetInferenceProfile",
    ]
    resources = ["*"]
  }

  # A cross-Region inference profile sends the call to the foundation model in another Region.
  statement {
    sid       = "InvokeModels"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = local.invoke_resource_arns
  }
}

resource "aws_iam_role_policy" "gateway" {
  name   = "${var.name}-gateway"
  role   = local.role_name
  policy = data.aws_iam_policy_document.gateway.json
}

resource "aws_bedrockagentcore_gateway" "this" {
  name            = var.name
  description     = "Amazon Bedrock inference with LangGuard policy"
  role_arn        = local.role_arn
  authorizer_type = var.authorizer_type

  dynamic "authorizer_configuration" {
    for_each = var.authorizer_type == "CUSTOM_JWT" ? [1] : []
    content {
      custom_jwt_authorizer {
        discovery_url    = var.jwt_discovery_url
        allowed_audience = length(var.jwt_allowed_audience) > 0 ? var.jwt_allowed_audience : null
        allowed_clients  = length(var.jwt_allowed_clients) > 0 ? var.jwt_allowed_clients : null
      }
    }
  }

  # REQUEST only: a RESPONSE interceptor in the default BUFFERED mode holds a streamed answer until the model ends.
  interceptor_configuration {
    interception_points = ["REQUEST"]

    interceptor {
      lambda {
        arn = module.interceptor.function_arn
      }
    }

    input_configuration {
      pass_request_headers = true
    }
  }

  lifecycle {
    precondition {
      condition     = var.authorizer_type != "CUSTOM_JWT" || var.jwt_discovery_url != ""
      error_message = "Set jwt_discovery_url when authorizer_type is CUSTOM_JWT."
    }
  }

  depends_on = [aws_iam_role_policy.gateway]
}

resource "aws_bedrockagentcore_gateway_target" "bedrock" {
  name               = "bedrock"
  gateway_identifier = aws_bedrockagentcore_gateway.this.gateway_id
  description        = "Amazon Bedrock Runtime (InvokeModel, Anthropic Messages, OpenAI Chat)"

  target_configuration {
    inference {
      connector {
        source {
          connector_id = "bedrock-runtime"
        }
      }
    }
  }

  credential_provider_configuration {
    gateway_iam_role {}
  }

  depends_on = [aws_iam_role_policy.gateway]
}
