variable "region" {
  description = "Region of the gateway, the interceptor and the Amazon Bedrock models."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name of the gateway. The interceptor function is <name>-interceptor and the gateway role is <name>-gateway."
  type        = string
  default     = "langguard-inference"
}

variable "langguard_url" {
  description = "Base URL of LangGuard, for example https://langguard.example.com."
  type        = string
}

variable "langguard_api_key_secret_arn" {
  description = "ARN of the Secrets Manager secret that holds the LangGuard API key (lgr_...) as a plain string."
  type        = string
}

variable "authorizer_type" {
  description = "Inbound authorizer of the gateway: AWS_IAM (callers sign with SigV4, as Claude Code does with CLAUDE_CODE_USE_BEDROCK) or CUSTOM_JWT."
  type        = string
  default     = "AWS_IAM"

  validation {
    condition     = contains(["AWS_IAM", "CUSTOM_JWT"], var.authorizer_type)
    error_message = "authorizer_type must be AWS_IAM or CUSTOM_JWT."
  }
}

variable "jwt_discovery_url" {
  description = "OpenID Connect discovery URL of the identity provider. Required with CUSTOM_JWT."
  type        = string
  default     = ""
}

variable "jwt_allowed_audience" {
  description = "Audiences that the CUSTOM_JWT authorizer accepts."
  type        = list(string)
  default     = []
}

variable "jwt_allowed_clients" {
  description = "Client IDs that the CUSTOM_JWT authorizer accepts."
  type        = list(string)
  default     = []
}

variable "user_claim" {
  description = "JWT claim that LangGuard uses as the user ID, for example email. Only with CUSTOM_JWT."
  type        = string
  default     = ""
}

variable "sts_key_map_enabled" {
  description = "Make the STS key map, which gives LangGuard the IAM Identity Center user of a SigV4 call. Only with AWS_IAM."
  type        = bool
  default     = false
}

variable "existing_gateway_role_name" {
  description = "Name of an existing gateway service role. The template then adds its policy to that role and does not create a role. Empty means the template creates the role."
  type        = string
  default     = ""
}

variable "invoke_model_resource_arns" {
  description = "ARNs that the gateway role can call with bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream. Empty means all models: foundation models, inference profiles, application inference profiles, provisioned models, custom model deployments and imported models of the account. For an inference profile, also give the ARNs of its foundation models in each Region that the profile sends calls to."
  type        = list(string)
  default     = []
}

variable "secret_kms_key_arn" {
  description = "ARN of the customer-managed KMS key that encrypts the API key secret. Empty means the secret uses the AWS managed key."
  type        = string
  default     = ""
}

variable "role_permissions_boundary_arn" {
  description = "ARN of the permissions boundary for the function role. Empty means no boundary."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Subnets for the function. Set them when LangGuard has a private endpoint. The subnets need a path to LangGuard and to Secrets Manager. Empty means no VPC."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Security groups for the function. Use them together with subnet_ids."
  type        = list(string)
  default     = []
}
