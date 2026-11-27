# Apply LangGuard policy to AgentCore Gateway tool calls and model calls

This AWS Lambda function is a gateway interceptor for Amazon Bedrock AgentCore Gateway. It sends each MCP `tools/call` to LangGuard for a policy decision and applies the verdict. On a gateway with an inference target, it also sends each model call to LangGuard before the gateway calls the model (see "Check model calls on an inference gateway").

```text
agent -> gateway -> REQUEST interceptor -> LangGuard -> target -> RESPONSE interceptor -> LangGuard -> agent
```

The REQUEST interceptor sends the tool name and arguments to LangGuard. The RESPONSE interceptor sends the tool result. If LangGuard blocks the call, the agent gets an MCP tool result with `isError: true` and the reason as text. Other MCP methods, such as `tools/list`, go through without a LangGuard call.

The function uses Node.js 22 and has no npm dependencies. It reads the API key with the AWS SDK that the Lambda runtime includes.

## Before you start

You need:

- A gateway with a `CUSTOM_JWT` or an `AWS_IAM` inbound authorizer. With `CUSTOM_JWT`, the user comes from a token claim. With `AWS_IAM`, the user comes from the STS key map, which needs IAM Identity Center (see "Find the user of an AWS_IAM call").
- A LangGuard API key with the **Ingest** scope. Create it in LangGuard on the API keys page. The page cannot create a key with the `arbiter` scope, and an Admin key gives more access than the function needs. Store the key (`lgr_...`) as a plain string in AWS Secrets Manager, not as JSON. If a customer-managed KMS key encrypts the secret, set `secret_kms_key_arn`.
- An `https://` URL for LangGuard. The function does not send the key over plain HTTP.
- A network path from the Lambda to LangGuard. If LangGuard has a private endpoint, set `subnet_ids` and `security_group_ids` so the Lambda runs in a VPC that can reach it.
- A network path from the Lambda to Secrets Manager. In a VPC, use a Secrets Manager interface endpoint or a NAT gateway.
- Terraform 1.5 or later.

## Deploy the function

1. Go to the `terraform` directory of this package.

   ```sh
   cd terraform
   ```

2. Initialize Terraform.

   ```sh
   terraform init
   ```

3. Apply the template.

   ```sh
   terraform apply \
     -var 'langguard_url=https://langguard.example.com' \
     -var 'langguard_api_key_secret_arn=arn:aws:secretsmanager:us-east-1:111122223333:secret:langguard-api-key-AbCdEf'
   ```

4. Copy the `function_arn` output. You use it in the next section.

The template creates the function, its execution role, permission to read the one secret, and, when `sts_key_map_enabled` is `true`, the STS key map (see "Find the user of an AWS_IAM call"). The Lambda timeout is `ceil((timeout_ms + 3000) / 1000) + 2` seconds: 3000 ms for the key read, `timeout_ms` for LangGuard, and 2 seconds of margin. It does not create the secret or the gateway. It creates the permission for the gateway to call the function only when `gateway_role_arn` is set.

## Attach the function to the gateway

1. Give the gateway service role permission to call the function. Add `lambda:InvokeFunction` on the `function_arn` to the role. Do not use a wildcard resource.

   If you cannot change the role, set the Terraform variable `gateway_role_arn` instead. The template then adds a resource-based permission to the function for that role. This works when the role and the function are in the same account.

2. Add the function as both the REQUEST and the RESPONSE interceptor. Set `passRequestHeaders` to `true`. Without the headers, LangGuard gets no user identity, no session ID, and no trace ID.

   ```json
   [{
     "interceptor": {
       "lambda": {
         "arn": "arn:aws:lambda:us-east-1:111122223333:function:langguard-agentcore-interceptor"
       }
     },
     "interceptionPoints": ["REQUEST", "RESPONSE"],
     "inputConfiguration": {
       "passRequestHeaders": true
     }
   }]
   ```

   Use this value for `--interceptor-configurations` with `aws bedrock-agentcore-control create-gateway` or `update-gateway`.

A gateway can have [at most one REQUEST interceptor and one RESPONSE interceptor](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors.html). If the gateway already has an interceptor, this function cannot run next to it.

## Behavior

A LangGuard result passes when `valid` is `true`, or when `valid` is `false` with severity `warn`. Every other result blocks.

| LangGuard result | What the agent gets |
| --- | --- |
| Allow | The tool call or the tool result, unchanged. |
| Block | An `isError` tool result with the policy message. The tool does not run, or its result is replaced. |
| ASK (approval needed) | Blocked. AgentCore Gateway has no approval prompt. |
| Shadow mode, or a notify-only policy | Not blocked by a policy result. LangGuard records the decision only. Two cases block in every mode: LangGuard cannot be reached, or LangGuard has quarantined the agent. When LangGuard cannot read the enforcement mode, it blocks each call that Enforce mode would block. For the other calls it uses the older blocking rule of Shadow mode: a violation with block status, an unreachable policy engine, an evaluation error of an enforce policy, an escalation, and a remembered deny block. |
| LangGuard not reachable, timeout, HTTP error, or bad response | Blocked with the "unavailable" text. There is no setting that allows calls when LangGuard is down. |
| LangGuard answers HTTP 413 because the tool call or the tool result is larger than 1 MB | Blocked with the "too large" text. |
| LangGuard answers JSON-RPC error `-32602` (invalid params) | Blocked with the "not valid" text. |
| `LANGGUARD_URL` is not set or is not `https://` | Blocked with the "unavailable" text. The function does not call LangGuard. |
| Secret cannot be read, or the read takes more than 3000 ms | Blocked with the "unavailable" text. |
| `tools/call` has no tool name, the tool name is not a string, or the event is not valid | Blocked with the "not valid" text. The function does not call LangGuard. |
| REQUEST phase: `arguments` of the `tools/call` is not an object (`null` counts as no arguments) | Blocked with the "not valid" text. The function does not call LangGuard. |
| RESPONSE phase: `arguments` of the `tools/call` request is not an object | The function sends the call to LangGuard without arguments, with the result, and follows the LangGuard result. |
| Response event without a readable `tools/call` request, or a `tools/call` response body that is not an object | Blocked with the "not valid" text. |

The agent gets one of four block texts:

| Cause | Text |
| --- | --- |
| Policy | `Blocked by LangGuard policy: <policy message>` |
| Unavailable | `Blocked by LangGuard: the policy check is unavailable, so this tool call is not allowed.` |
| Not valid | `Blocked by LangGuard: this is not a valid tool call or tool result, so it was not sent for a policy check.` |
| Too large | `Blocked by LangGuard: the tool call or its result is larger than 1 MB, the size limit of the policy check, so it is not allowed.` |

A block from the REQUEST interceptor has the JSON-RPC `id` of the request. A block from the RESPONSE interceptor has the `id` of the response that it replaces. If that message has no `id` member, the block has no `id` member. The block has `id: null` only when the function cannot read the request body.

The gateway rejects some requests before a tool runs. A JSON-RPC batch (array), a method name in a different case or with a space (for example `Tools/Call`), and a body that is not JSON get HTTP 400 with JSON-RPC error `-32600`.

The function does not evaluate these events. It returns them unchanged:

- MCP methods other than `tools/call`.
- A response that has no `result`: a JSON-RPC error from the target, or a request from the server such as `elicitation/create` on a streaming response.
- Events for HTTP targets (an `http` payload) with a path that is not under `/inference` and that no model call row agrees with (see "Routes"), and each `http` RESPONSE event. The function returns an empty `http` object. AWS documents that as pass-through for the RESPONSE interceptor ([interceptor types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html)) and, in its model routing example, for the REQUEST interceptor of an inference target ([interceptor examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-examples.html)).

The gateway also sends the block that the REQUEST interceptor made to the RESPONSE interceptor. The function recognises its own block by an HMAC signature over the response ID and the block text, made with the API key. It then returns only the block text, without a LangGuard call.

The function writes one JSON log line for each call, with the phase, tool name, outcome, reason, duration, trace ID, and the outcome of the key map lookup (`caller`). The client chooses the tool name, so the log line has it without control characters and cut to 256 characters. A cut name has `toolNameLength`, the length of the full name. LangGuard gets the full name. When the body is not a JSON-RPC object (`unsupported` outcome), the line also has `bodyShape` (type, length, a `data:`, `event:`, `{` or `[` prefix, or the key names) and `fieldNames` (the key names of the `gatewayRequest` or `gatewayResponse` object). The client or the target chooses the key names of a body, so `bodyShape` names only JSON-RPC and MCP protocol words (`jsonrpc`, `id`, `method`, `params`, `result`, `error`, `name`, `arguments`, `content`, `isError`, `structuredContent`, `_meta`, `code`, `message`, `data`) and gives the number of other names as `otherKeys`. For a method that it passes through, the reason names the method only when it has the form of an MCP method (segments of letters and `_` that start with a lower-case letter, with `/` between them, 64 characters at most, for example `notifications/roots/list_changed`). Other methods are logged as `other`. It does not log headers, tokens, arguments, tool results, body content, or the API key.

## What LangGuard receives

| LangGuard field | Source |
| --- | --- |
| `context.traceId`, `context.spanId` | The `traceparent` header (W3C). Without that header, the trace ID is the gateway's own trace ID, which Lambda supplies as `_X_AMZN_TRACE_ID`, and there is no span ID. LangGuard joins the decision to that trace. |
| `context.sessionId` | The `Mcp-Session-Id` header. |
| `context.principal.id` | The `sub` claim of the bearer token. |
| `context.principal.claims` | The string claims `user_id`, `ai_app_id`, `department`, and `environment` only. |
| `config.langguard.user_id` | The claim that `LANGGUARD_USER_CLAIM` names. For a SigV4-signed call, the IAM Identity Center user name from the STS key map. |
| `config.langguard.agent_type` | Always `agentcore`. |

The function decodes the bearer token but does not verify its signature. The gateway inbound authorizer verifies the token before the interceptor runs. The function does not send the token to LangGuard.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `LANGGUARD_URL` | Yes | None | Base URL of LangGuard. It must start with `https://`. The function sends requests to `<LANGGUARD_URL>/api/interceptor`. |
| `LANGGUARD_API_KEY_SECRET_ARN` | Yes | None | ARN of the secret that holds the API key. The function keeps the key in memory for 5 minutes. After that, it uses the old key while it reads the secret again. If LangGuard rejects the key (HTTP 401 or 403), it reads the secret again at once. |
| `LANGGUARD_TIMEOUT_MS` | No | `5000` | Time limit for one LangGuard call, in milliseconds. It must be a whole number. Another value blocks each call with the "unavailable" text, and the function does not call LangGuard. |
| `LANGGUARD_AUTHORIZER` | No | `CUSTOM_JWT` | Inbound authorizer of the gateway: `CUSTOM_JWT`, `AWS_IAM` or `NONE`. The function reads the claims of a `Bearer` token only with `CUSTOM_JWT`, because only that authorizer verifies the token. With `AWS_IAM` or `NONE`, it ignores a `Bearer` token. |
| `LANGGUARD_USER_CLAIM` | No | None | Name of the JWT claim to send as the user ID, for example `email`. It has an effect only with `CUSTOM_JWT`. |
| `LANGGUARD_KEY_MAP_TABLE` | No | None | Name of the STS key map table. When it is not set, the function does not look up SigV4 callers. |
| `LANGGUARD_KEY_MAP_TIMEOUT_MS` | No | `400` | Time limit for one key map lookup, in milliseconds, from 1 to 5000. Another value uses the default. |
| `LANGGUARD_GATEWAY_KIND` | No | None | Set to `inference` when the function serves only gateways with an inference target (see "Inference gateway mode"). Another value that is not empty blocks each `http` REQUEST event with the "unavailable" text, and the function does not call LangGuard. |

The Terraform variables `langguard_url`, `langguard_api_key_secret_arn`, `timeout_ms` (a whole number up to 20000), `gateway_authorizer_type` (default `CUSTOM_JWT`), and `user_claim` set these values. `user_claim` needs `gateway_authorizer_type = "CUSTOM_JWT"`. `secret_kms_key_arn` gives the function `kms:Decrypt` on the key that encrypts the secret, only through Secrets Manager.

More Terraform variables are optional:

- `gateway_role_arn` lets that gateway service role call the function.
- `role_permissions_boundary_arn` sets a permissions boundary on the function role and on the key map writer role.
- `log_group_name` sends the function logs to that log group and not to `/aws/lambda/<function_name>`.
- `sts_key_map_enabled` (default `false`) creates the STS key map. Set it to `true` for a gateway with `AWS_IAM`, together with `gateway_authorizer_type = "AWS_IAM"`. The deploy role then also needs to create DynamoDB, EventBridge and Lambda resources in `sts_global_region`. The template needs AWS provider 6.0 or later. For an existing deploy on provider 5.x, run `terraform init -upgrade` first.
- `sts_role_name_prefix` (default `AWSReservedSSO_`) is the role name prefix that the key map accepts.
- `sts_global_region` (default `us-east-1`) is the Region where CloudTrail logs calls to the STS global endpoint. Set it for another partition, for example `us-gov-west-1`.
- `sts_key_map_extra_regions` (default empty) adds a writer and a rule in more Regions.

## Find the user of an AWS_IAM call

With the `AWS_IAM` authorizer, the client signs each call with SigV4. The `Authorization` header then holds an access key ID and no user name. The STS key map connects the two. You do not install anything on the developer machines.

1. A user signs in with IAM Identity Center. Identity Center calls STS `AssumeRoleWithSAML` for an `AWSReservedSSO_*` role in the member account.
2. CloudTrail records the call with the new access key ID, its expiration, and the session name. The session name is the Identity Center user name.
3. An EventBridge rule sends the event to the key map writer. The writer stores one item in the DynamoDB table: `accessKeyId`, `userName` (the session name only), and `expiresAt` (epoch seconds). DynamoDB deletes the item after `expiresAt`.
4. For each `tools/call`, the interceptor reads the access key ID from the SigV4 `Authorization` header, looks it up in the table, and sends the user name as `config.langguard.user_id`.

You need:

- IAM Identity Center for the users of the gateway. A long-term IAM user key or a role that is not an Identity Center role gets no user.
- `passRequestHeaders` set to `true` on the interceptor.
- In a VPC, a network path from the interceptor to DynamoDB, for example a DynamoDB gateway endpoint. Without it, each lookup fails after its time limit and the call gets no user.

The template creates these resources when `sts_key_map_enabled` is `true`:

- The DynamoDB table `<function_name>-key-map`, with on-demand capacity, a TTL on `expiresAt`, and encryption with the AWS managed KMS key.
- The writer function `<function_name>-key-map-writer` and the EventBridge rule `<function_name>-key-map-sign-in`. They are in the Region of the interceptor, in `sts_global_region`, and in each Region of `sts_key_map_extra_regions`. STS logs a call to the global endpoint in us-east-1 (commercial partition) and a call to a Regional endpoint in that Region. Each writer writes to the one table in the Region of the interceptor.
- The writer role, with `dynamodb:PutItem` on the table only.
- `dynamodb:GetItem` on the table only, for the interceptor role.

The rule state is `ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS`, because CloudTrail logs `AssumeRoleWithSAML` as a read-only event. A rule in the `ENABLED` state does not get read-only events. The writer accepts only a successful `AssumeRoleWithSAML` event for a role under the IAM path `/aws-reserved/sso.amazonaws.com/` of the same account, whose name starts with `sts_role_name_prefix`. IAM Identity Center makes its roles under that path (AWS IAM Identity Center guide, "Referencing permission sets"). A role that someone makes with the same name prefix but another path gets no item. It is not verified whether IAM refuses a customer role under that path. It writes one JSON log line for each event, with the outcome and the reason. The line has only the first 4 characters of the key ID, and no user name.

The lookup does not block a call and does not make a call slow:

- A lookup has a limit of 400 ms (`LANGGUARD_KEY_MAP_TIMEOUT_MS`). At the limit, the call goes to LangGuard with no user. The lookup continues, and the next call uses its result.
- A timeout, a DynamoDB error, or a key that is not in the table gives no user. The call still goes to LangGuard for the policy decision.
- The function keeps a found user in memory until the credentials expire. It keeps a key that is not in the table for 10 seconds, because the sign-in event can arrive after the first call. It keeps 1000 keys at most.
- With `LANGGUARD_AUTHORIZER = AWS_IAM`, the function ignores a `Bearer` token, so a forged token cannot name another user. With `CUSTOM_JWT`, a JWT claim user wins, and a `Bearer` token gets no key map lookup.
- A SigV4a header (`AWS4-ECDSA-P256-SHA256`) or a header in another format gets no lookup and no user.
- The log line gets `caller` with the outcome only: `hit`, `miss`, `timeout`, `error`, `off` (no table), or `none` (no SigV4 header).

These parts are not measured on a real gateway or account:

- That Identity Center calls `AssumeRoleWithSAML` in the member account, and in which Region CloudTrail logs it. The AWS CloudTrail documentation shows the event shape and the expiration format (`Aug 28, 2023, 7:00:58 PM`, UTC). The key ID and the ARN shape were measured on `AssumeRole` events in a dev account. If the events go to another Region, add it to `sts_key_map_extra_regions`.
- That the session name is the user name that LangGuard knows. With Entra ID and SCIM, it is usually the user principal name, for example `jane@corp.com`.
- The delay from the sign-in to the event at the writer. The first call after a sign-in can get no user.
- That the `Authorization` header reaches the interceptor on a gateway with `AWS_IAM`.
- That EventBridge gets the `AssumeRoleWithSAML` event in an account with no CloudTrail trail.

The gateway `AWS_IAM` authorizer checks the signature, so the key ID in a signed header belongs to the caller (inferred, not tested). A caller that signs in the query string can put a different `Authorization` header with the key ID of another user. The function then sends the user of that key, so LangGuard records the call for the wrong person and evaluates the policy for that person. An access key ID is not a secret. It is in CloudTrail records and in logs. This case is not tested. The interceptor event does not include the query string, so the function cannot detect it.

A call can get no user: the first call after a sign-in, a lookup at its time limit, a role that a user assumed from Identity Center credentials, or a key that is not from Identity Center. So use the key map user to show who made a call, and in policies that deny a user. Do not use it in a policy that allows a call only for a named user.

## Limits and known gaps

- On a real AgentCore Gateway, the function has run for `tools/list`, `ping`, a `tools/call` that LangGuard blocked, and a `tools/call` that passed in Shadow mode in both phases. It has also run with Claude Code as the client: the session start passed, and Claude Code got the policy message as a tool error for a blocked call. Twelve parallel calls all got a result. A string `id` works. For `"arguments": null`, the function sends the call to LangGuard as a call with no arguments, and the gateway then rejects the call with HTTP 400 when LangGuard lets it pass. A JSON-RPC error from the target passes through the RESPONSE interceptor. A JWT authorizer is not verified on a real gateway. The automated tests use the example payloads from the AgentCore developer guide.
- Streaming: do not turn on MCP response streaming (`protocolConfiguration.mcp.streamingConfiguration.enableResponseStreaming`) on a gateway that uses this function. The RESPONSE phase does not hold a block for a streamed response. Results of a live test on the test gateway with streaming on:
  - A `tools/call` that the REQUEST interceptor allows gets `Content-Type: text/event-stream` with one `data:` event when the `Accept` header includes `text/event-stream`, with and without a `progressToken`. With `Accept: application/json`, the gateway sends one `application/json` response. Claude Code and the AWS MCP proxy send `Accept: application/json, text/event-stream`, so their tool results stream. `tools/list` and a REQUEST-phase block always get one `application/json` response.
  - A REQUEST-phase block holds: the client gets HTTP 200 `application/json` with the block, for each `Accept` value.
  - For a streamed result, the gateway calls the function once in the RESPONSE phase, and that event does not have the result. A capture on 2026-11-24 (4 streamed calls, 3 tools) shows the event: `gatewayResponse` has the keys `headers`, `httpMethod`, `isStreamingResponse`, `path` and `statusCode`, and no `body` key. The log line has `bodyShape: {"type":"undefined"}`. The gateway does not call the function again for the `data:` event that has the result. So the function never gets a streamed tool result, and no change to the function can check one. For this event the function returns a block, but the gateway ignores it and the client gets the target's result. So a RESPONSE-phase block (a policy verdict on the result, or a result larger than 1 MB) does not exist for a streamed response. The function does not log the event: for a body that is not a JSON-RPC object, it logs only `bodyShape` and `fieldNames` (see the log line above).
  - The gateway span has the trace ID of the REQUEST-phase decision.
  - The automated tests use the AWS example payloads for a streamed event (`isStreamingResponse: true`). They do not match the live event: the AWS examples have a `body` in each streamed event.
- A `tools/call` without an `id` member runs on the gateway when LangGuard allows it. The gateway answer then has no `id` member. When the function returned a block with `id: null` for such a call, the gateway answered HTTP 500 (`InterceptorException`). The function now returns a block without an `id` member, and the gateway accepts it: the client gets HTTP 200 and the block.
- A direct invoke of the deployed function verified that the `Authorization`, `traceparent`, and `Mcp-Session-Id` headers reach LangGuard, with any header-name case. It did not go through the gateway.
- The function makes a row in Trace Explorer only for a blocked call. The row of a call that passes comes from the gateway's own span: the AWS AgentCore integration in LangGuard reads the spans from CloudWatch Logs, and LangGuard merges the two on the trace ID. The integration needs trace delivery on for the gateway.
- Each `tools/call` makes two LangGuard calls, one for each phase. In the test, a warm function added about 0.4 to 0.6 seconds for each of them.
- The agent name does not reach LangGuard. LangGuard accepts only a fixed list of agent names, so a blocked call shows no agent name.
- The function decodes a `Bearer` token in the `Authorization` header and does not verify it. It relies on the gateway `CUSTOM_JWT` authorizer to verify the token, so it reads the token only when `LANGGUARD_AUTHORIZER` is `CUSTOM_JWT` (the default). Set `gateway_authorizer_type` to `AWS_IAM` or `NONE` for a gateway without a JWT authorizer. Otherwise a caller can send a forged token and name another user.
- LangGuard rejects a request body larger than 1 MB with HTTP 413. A larger tool call or tool result is blocked. A direct invoke of the deployed function with a 1.3 MB tool result verified the block. A 200 KB tool result passed.
- The trace ID of a decision is the trace ID of the gateway's spans. The gateway continues a `traceparent` header from the client. Without the header, the gateway makes a trace ID, and Lambda supplies it to the function only when tracing is on for the gateway. With no header and no tracing, the decision has no trace ID. A test on the real gateway showed the three trace IDs. The fallback itself has run in the automated tests only, not on the gateway.
- With response streaming, the gateway sends `notifications/message` and `notifications/progress` to the client without the interceptor.
- A JSON-RPC error from a target and a request from the server reach the agent without a LangGuard check.
- The session ID comes from the caller's headers, and so does the trace ID when the caller sends `traceparent`. The function does not verify them.
- The block marker is an HMAC-SHA256 with the API key over the JSON-RPC `id` and the block text. A review tried forged markers: without the key, none was accepted. A party that has seen one genuine block can replay it for the same `id`. The function then shows that old block text in place of one tool result. A replay can only block: it cannot make a result pass.
- The event does not name its phase. A real gateway sends the `gatewayResponse` key in a REQUEST event too, with the value `null`. So the function reads an event as a REQUEST when `gatewayResponse` is missing or `null`, and as a RESPONSE for each other value. A value that is not an object ends as the `unsupported` block, and the reason names its type, for example `gatewayResponse is not an object (string)`.
- After a key rotation, a warm function uses the old key until LangGuard rejects it. A test with a wrong key in the secret showed this: the function used the cached key for the 5-minute cache time, then blocked each call (HTTP 401 from LangGuard). After the correct key was back in the secret, the next call passed the key check.
- The AgentCore documentation does not say what the gateway does when the Lambda fails or times out. It says that the gateway can retry the Lambda. The function does not throw. It returns a block for every error it can catch.

## Check model calls on an inference gateway

An AgentCore Gateway with an inference target serves model APIs under `/inference`. Claude Code can send its Amazon Bedrock calls to that path. The interceptor then gets each model call before the gateway calls Amazon Bedrock. You do not install anything on the developer machines.

```text
Claude Code -> gateway /inference -> REQUEST interceptor -> LangGuard -> Amazon Bedrock -> Claude Code
```

### Deploy the inference gateway

The `examples/inference-gateway` directory has a Terraform template. It needs AWS provider 6.73 or later. It creates:

- The interceptor function, from the `terraform` module of this package. Set `secret_kms_key_arn` when a customer-managed KMS key encrypts the secret, `role_permissions_boundary_arn` for a permissions boundary on the function role, and `subnet_ids` with `security_group_ids` when LangGuard has a private endpoint.
- A gateway with no protocol type and the `AWS_IAM` authorizer. Set `authorizer_type = "CUSTOM_JWT"` and `jwt_discovery_url` for a JWT authorizer.
- A target with the `bedrock-runtime` inference connector. The gateway calls Amazon Bedrock with its own role (`GATEWAY_IAM_ROLE`). Amazon Bedrock sees each call as the gateway role, not as the developer.
- The interceptor on REQUEST only, with `pass_request_headers = true`. Do not add the function as a RESPONSE interceptor on this gateway. In the default `BUFFERED` mode, a RESPONSE interceptor holds a streamed answer until the model ends.
- The gateway role, or a policy on the role that `existing_gateway_role_name` names. The policy is named `<name>-gateway`, so two deployments with different `name` values can share one role. The policy has `lambda:InvokeFunction` on the interceptor, `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on foundation models, inference profiles, application inference profiles, provisioned models, custom model deployments and imported models (set `invoke_model_resource_arns` to give fewer models), `bedrock:GetFoundationModel`, `bedrock:GetInferenceProfile`, and the list actions that the target uses to find the models: `ListFoundationModels`, `ListInferenceProfiles`, `ListProvisionedModelThroughputs`, `ListCustomModelDeployments`, `ListImportedModels`, `ListMarketplaceModelEndpoints` and `ListPromptRouters` ([InvokeModel with inference targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-inference-invokemodel.html)). If the role cannot do a list action, the target does not get to the `Ready` state.

1. Go to the example directory.

   ```sh
   cd examples/inference-gateway
   ```

2. Initialize Terraform.

   ```sh
   terraform init
   ```

3. Apply the template.

   ```sh
   terraform apply \
     -var 'langguard_url=https://langguard.example.com' \
     -var 'langguard_api_key_secret_arn=arn:aws:secretsmanager:us-east-1:111122223333:secret:langguard-api-key-AbCdEf'
   ```

4. Copy the `claude_code_env` output into the `env` block of the Claude Code managed settings. It sets `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, and `ANTHROPIC_BEDROCK_BASE_URL` to the `/inference` path of the gateway. The developers then need `bedrock-agentcore:InvokeGateway` on the gateway, and no Amazon Bedrock permissions.

### Routes

The function reads the method and the path of each REQUEST event. First it makes the path normal: it removes the query, empty segments (`//` and a trailing `/`), `.` segments and `..` segments, and decodes each segment (`%6Dodel` becomes `model`). It compares each segment other than the model ID without case. A path with a bad percent escape is blocked with the "not valid" text. Then it removes `inference` from the start of the path, if the path has it. The first row that agrees with the call decides. The rows that are marked "under `/inference` only" agree only with a path that had `/inference`, or with each path when `LANGGUARD_GATEWAY_KIND` is `inference`. Thus a model call gets the same check with or without `/inference` in the event path.

A pass needs a path in normal form, because a pass must not depend on how the gateway and Amazon Bedrock read the path. A path in normal form starts with `/`, has no `?` or `#` (a `GET` can have a query), has no empty, `.` or `..` segment (a trailing `/` is allowed), and has only printable ASCII with no `\`, `;`, `?`, `#` or `%` in each decoded segment. A decoded `/` is allowed only on the count-tokens row, in a model ID that starts with `arn:` and has no empty, `.` or `..` part. When the row is a pass row, or no row agrees, and the path is not in normal form, the function blocks the call with the "not valid" text and does not call LangGuard. For example, `POST /inference/../v1/responses` and `POST /model/x/count-tokens/invoke/..` are blocked. A LangGuard check row does not need a path in normal form.

| Method and path | Action |
| --- | --- |
| `POST /model/{model}/invoke` | LangGuard check. Dialect `bedrock_invoke`, `stream` is `false`. |
| `POST /model/{model}/invoke-with-response-stream` | LangGuard check. Dialect `bedrock_invoke`, `stream` is `true`. |
| `POST /model/{model}/count-tokens` | Pass. No model runs. |
| `POST /v1/messages` | LangGuard check. Dialect `anthropic_messages`. `model` and `stream` come from the body. |
| `POST /v1/chat/completions` | LangGuard check. Dialect `openai_chat`. `model` and `stream` come from the body. |
| `GET` on each path, for example `/inference-profiles` and `/v1/models` (under `/inference` only) | Pass. No model runs. |
| Each other call, for example `POST /v1/responses` (under `/inference` only) | Blocked with the "not supported" text. LangGuard cannot check it. |
| A path in normal form without `/inference` that no row agrees with, for example `POST /v1/orders` of an HTTP target | Pass. |

`{model}` is one or more segments, because the ARN of an application inference profile has a `/`. The function decodes the model ID (`%3A` becomes `:`, `%2F` becomes `/`) and keeps its case. A RESPONSE event passes. The function reads an event as a RESPONSE event only when `gatewayResponse` is an object with a number `statusCode` or a boolean `isStreamingResponse`. Another value that is not `null` blocks the call with the "not valid" text.

The function sends `interceptor/invoke_model` to the same LangGuard endpoint and with the same API key as a tool call. The params have `payload` (`dialect`, `model`, `stream`, the request `body`, and `truncated`), `config.langguard`, and `context`, with the same sources as a tool call (see "What LangGuard receives"). For a SigV4-signed call, the STS key map gives the user, as for a `tools/call`.

### Inference gateway mode

The function can serve an MCP gateway, a gateway with HTTP targets and an inference gateway at the same time. Then a path in normal form without `/inference` that no row agrees with passes, because it can be a path of an HTTP target. A path of an HTTP target that is not in normal form, for example `/api//orders`, is blocked. If the inference gateway gives the event path without `/inference`, a call to an inference API that LangGuard cannot check then passes: `POST /model/{model}/converse`, `/converse-stream`, `/async-invoke`, `/invoke-with-bidirectional-stream` and `POST /v1/responses`.

Set `LANGGUARD_GATEWAY_KIND` to `inference` on a function that serves only inference gateways. The function then reads each path as a path under `/inference`. Each `http` REQUEST event that no LangGuard check row and no pass row agrees with is blocked with the "not supported" text, with or without `/inference`. Do not set it on a function that also serves HTTP targets: it blocks their calls. The `examples/inference-gateway` template and the test rig make a function of their own for the inference gateway and set `gateway_kind = "inference"` in the `terraform` module.

### Blocks

A block is a response from the gateway in the error format of the client. The gateway then does not call Amazon Bedrock.

| Dialect | Status | Headers | Body |
| --- | --- | --- | --- |
| `bedrock_invoke` | 451 | `x-amzn-ErrorType: AccessDeniedException` | `{"message": "<text>"}` |
| `anthropic_messages` | 403 | None | `{"type": "error", "error": {"type": "permission_error", "message": "<text>"}}` |
| `openai_chat` | 403 | None | `{"error": {"message": "<text>", "type": "permission_denied"}}` |

The `bedrock_invoke` status is 451, not 403, because of Claude Code. In a test with a local stand-in for the gateway, Claude Code 2.1.331 sent a call that was blocked with HTTP 403 13 times in 243 seconds, and then showed an AWS authentication error before the LangGuard text. With HTTP 451 it sent the call 1 time and showed only the LangGuard text. The `x-amzn-ErrorType` header stays `AccessDeniedException`, and the AWS CLI reports that error name with the two statuses.

The function uses the `bedrock_invoke` format when no route gives a format: for a request whose path or `gatewayResponse` it cannot read, for a path that is not in normal form, and for a pass row (for example a `GET`) while `LANGGUARD_GATEWAY_KIND` has a value that is not `inference`. With that bad value, a call on a route with a format keeps that format, for example 403 for `/v1/messages`.

A blocked call to a path that is not supported uses the Amazon Bedrock format under `/model/`, the Anthropic format under `/v1/messages/`, and the OpenAI format for other paths.

| Cause | Text |
| --- | --- |
| Policy | `Blocked by LangGuard: <policy message>` |
| Unavailable | `Blocked by LangGuard: the policy check is unavailable, so this model call is not allowed.` |
| Not valid | `Blocked by LangGuard: this is not a valid model request, so it was not sent for a policy check.` |
| Not supported | `Blocked by LangGuard: LangGuard cannot check calls to this inference API, so this call is not allowed.` |
| Too large | `Blocked by LangGuard: the model request is too large for the policy check, so it is not allowed.` |

The rules for each LangGuard result are the same as for a tool call (see "Behavior"). Thus in Shadow mode LangGuard does not block a model call for a policy result, an escalation, or an unreachable policy engine. When LangGuard cannot be reached, the model call is blocked. A `bedrock_invoke` body without a string `anthropic_version` is not an Anthropic model call, so the function blocks it with the "not supported" text and does not call LangGuard. A JSON-RPC error `-32602` from LangGuard blocks the call with the "not valid" text. A body that is not a JSON object, a body with a key two times in one object, at any depth (LangGuard and Amazon Bedrock can read different values), or a call that names no model, is blocked with the "not valid" text, and the function does not call LangGuard.

### Size and binary content

The function sends each message of the request to LangGuard. It does not remove messages. It replaces the data of each binary content block with a short text, because the LangGuard policy check does not read binary content: the `source.data` of an Anthropic `image` or `document` block (also in a `tool_result`), and the `url` of an OpenAI `image_url` that is a `data:` URL. It does not change text. It sets `truncated` to `true` only when it replaced data. If the request is larger than the LangGuard limit for a model call, LangGuard answers HTTP 413, and the call is blocked with the "too large" text.

### Log line

For a model call, the log line also has `route` (the row name: `invoke`, `invoke_stream`, `count_tokens`, `messages`, `chat_completions`, `read`, `unsupported`, `other` for a path that no row agrees with, `unknown` for a path that the function cannot read, or `response`), `dialect`, `model` (without control characters, cut to 256 characters), and `truncated` when the function replaced binary content. It does not log the body, the prompt, headers, or the API key.

### Not verified on a real gateway

- The function has not run on a real inference gateway. The automated tests use synthetic events in the documented `http` payload form.
- That the REQUEST event has the path with `/inference`, for example `/inference/model/<model>/invoke`. The AWS documentation shows the client paths with `/inference` and the event path of an HTTP target as the client path. The function checks a model call with or without `/inference` in the event path. If the event path does not have `/inference` and `LANGGUARD_GATEWAY_KIND` is not set, each call that is not a LangGuard check row passes, for example `POST /model/{model}/converse`, `/converse-stream`, `/async-invoke`, `/invoke-with-bidirectional-stream` and `POST /v1/responses`. Set `LANGGUARD_GATEWAY_KIND` to `inference` on a function that serves an inference gateway.
- How the gateway routes a path that is not normal, for example `//inference`, `/Model/` or `%6Dodel`, and if the event path is the path before or after the gateway made it normal. The function makes each path normal before it uses the route table, so these spellings get the LangGuard check when a check row agrees. A pass needs a path in normal form, so a spelling that could agree with a pass row and reach a model is blocked. The tests do not show that the gateway and Amazon Bedrock read the path in the same way.
- That an application inference profile ARN in the path reaches the event with a literal `/` or with `%2F`. The function accepts both.
- That Amazon Bedrock rejects a body with a key two times in one object, or which value it uses. The function blocks such a body.
- What the gateway does with a model call that is larger than the event size limit of Lambda. The function does not measure the body. LangGuard answers HTTP 413 for a body larger than its limit, and the function then blocks the call.
- That the client gets the `x-amzn-ErrorType` header of a block. The AWS SDK uses that header to make an `AccessDeniedException`.
- That the gateway gives the HTTP status 451 of a `bedrock_invoke` block to the client unchanged. The AWS documentation states no limit on the status code of an interceptor response, and its examples use only 200.
- That the gateway gives the `Authorization` header of a SigV4 call to the interceptor. This is also not verified for tool calls (see "Find the user of an AWS_IAM call").

## Run the tests

From the package directory:

```sh
node --test
```
