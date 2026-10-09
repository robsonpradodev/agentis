# Support

For general help, setup questions, and design discussion, use GitHub Discussions.

For bugs and feature requests, open a GitHub issue with enough detail to
reproduce or evaluate the request.

For runtime problems, include:

- the output of `agentis doctor --json` and `GET /healthz`;
- the Agent, App, workflow run, and mission ids involved;
- the mission status, blocker, and effect receipts from `GET /v1/missions/:id`;
- the relevant safe activity log and technical trace, with secrets removed;
- channel connection status and provider acknowledgement state for delivery failures.

Do not report a workflow's green lifecycle state alone as proof of a successful external action.
For delivery or mutation bugs, include the authoritative mission and receipt state. Never paste API
keys, WhatsApp session credentials, `secrets.json`, raw authorization headers, or host secrets.

For an owner-channel retry, also include the failed channel action id and authorization basis. A
correct continuation is correlated semantically to the unfinished Mission and resumes its missing
idempotent effects; a duplicate action id, repeated approval, raw tool JSON, or a text-only promise
with no later receipt is a runtime defect. For multi-message or media failures, include the plan-step,
requirement, and item ids plus their provider states. Never inline private media bytes.

For conflicting legacy content in one Agent's private Brain, do not delete the Agent. Inspect it
with `agentis.agent.brain.inspect`, preview a selective archive with
`agentis.agent.brain.prune`, and apply the returned confirmation token while preserving the
canonical atom ids. This keeps the Agent identity, runtime, Apps, and Connections intact.
The equivalent operator API is `GET /v1/agents/:agentId/brain` followed by the preview/apply
calls to `POST /v1/agents/:agentId/brain/prune`.

For vulnerabilities, do not open a public issue. Report privately through
GitHub Security Advisories:

https://github.com/agentis-labs/agentis/security/advisories/new
