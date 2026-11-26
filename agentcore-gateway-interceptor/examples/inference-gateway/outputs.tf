output "gateway_id" {
  value = aws_bedrockagentcore_gateway.this.gateway_id
}

output "gateway_url" {
  description = "URL of the gateway."
  value       = aws_bedrockagentcore_gateway.this.gateway_url
}

output "anthropic_bedrock_base_url" {
  description = "Value of ANTHROPIC_BEDROCK_BASE_URL for Claude Code: the /inference path of the gateway."
  value       = local.inference_url
}

output "claude_code_env" {
  description = "The env block of the Claude Code managed settings that sends Claude Code to the gateway."
  value = {
    CLAUDE_CODE_USE_BEDROCK    = "1"
    ANTHROPIC_BEDROCK_BASE_URL = local.inference_url
    AWS_REGION                 = var.region
  }
}

output "interceptor_function_arn" {
  value = module.interceptor.function_arn
}

output "gateway_role_arn" {
  value = local.role_arn
}
