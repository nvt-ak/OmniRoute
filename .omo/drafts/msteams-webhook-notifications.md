---
slug: msteams-webhook-notifications
status: drafting
intent: clear
review_required: false
pending-action: resolve Microsoft Teams delivery contract, then write .omo/plans/msteams-webhook-notifications.md
approach: Extend the existing webhook subsystem with a Microsoft Teams kind, preserving its management authentication, encrypted metadata, SSRF protection, delivery audit, retry/disable policy, dashboard wizard, CLI parity, and focused automated tests.
---

# Draft: msteams-webhook-notifications

## Components (topology ledger)
| id | outcome (one line) | status | evidence path |
| --- | --- | --- | --- |
| delivery-contract | A supported Teams transport can post a notification to the configured destination. | active | Microsoft Teams Workflows / Graph official docs; `src/lib/webhookDispatcher.ts` |
| persistence-api | Teams configuration is validated, protected, stored, and editable through existing webhook APIs. | active | `src/lib/db/webhooks.ts`; `src/app/api/webhooks/route.ts`; `src/app/api/webhooks/[id]/route.ts` |
| event-delivery | Existing subscribed webhook events use a Teams-specific payload without blocking request paths. | active | `src/lib/webhookDispatcher.ts`; `src/lib/webhooks/eventDescriptions.ts` |
| dashboard-cli | Teams moves from dashboard “coming soon” to a configurable integration and existing CLI controls remain compatible. | active | `src/app/(dashboard)/dashboard/webhooks/components/steps/Step1ChooseIntegration.tsx`; `bin/cli/commands/webhooks.mjs` |
| verification | Payload, security, persistence, routes, and UI behavior are covered by focused tests. | active | `tests/unit/webhook-telegram-dispatcher.test.ts`; `tests/unit/api/webhooks/webhook-url-ssrf-guard.test.ts` |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| Integration transport | Teams Workflows webhook URL, not Microsoft Graph or a notification bot | It matches the requested webhook model and supports a configured Teams channel or chat; it avoids a new delegated OAuth flow. | yes |
| Destination representation | A workflow URL is the webhook URL; its configured Teams action owns whether the destination is a channel or group chat. | This avoids persisting Graph team/channel/chat identifiers when the workflow already owns routing. | yes |
| Credentials | Treat the workflow URL as a secret and do not send a bearer token for Workflows set to `Anyone`; authenticated trigger modes are deferred unless specifically required. | Microsoft documents that token headers break `Anyone` triggers; current webhook conventions already validate and redact destinations. | yes |
| Message contract | Start with the documented simple `{ "text": "..." }` workflow payload; do not introduce Adaptive Cards in the first integration. | Lowest-complexity interoperable payload; card schema depends on the customer workflow action. | yes |
| Test strategy | Tests-after, automated unit/route/security coverage. | Matches existing webhook integration test layers. | yes |

## Findings (cited - path:lines)
- The existing flow is event producer → `notifyWebhookEvent` → `dispatchEvent` → enabled-webhook/event filtering → integration payload → timed/retried delivery → delivery audit/failure disable in `src/lib/webhookDispatcher.ts`.
- `WebhookKind` is currently `slack | telegram | discord | custom` in `src/lib/db/webhooks.ts:9`; the API allowlists mirror it in `src/app/api/webhooks/route.ts` and `src/app/api/webhooks/[id]/route.ts`.
- `webhooks.kind` plus `metadata_encrypted` already support a kind-specific integration; Telegram is the closest precedent for encrypted credentials and a non-generic destination representation (`src/lib/webhooks/integrations/telegram.ts`).
- The dashboard already reserves `teams` as a coming-soon integration in `src/app/(dashboard)/dashboard/webhooks/components/steps/Step1ChooseIntegration.tsx` and `components/shared/IntegrationCard.tsx`.
- Every webhook administration route uses management auth and existing URL/delivery logic applies SSRF validation, timeout/retry, error sanitization, delivery retention, and failure-based disabling.
- Microsoft documents legacy Microsoft 365 Connectors as nearing deprecation. A Teams Workflows webhook can receive HTTP requests then post to a Teams channel or chat; legacy Incoming Webhooks are channel-scoped. Graph direct sends to channels/chats normally require delegated permissions, while application send permission is migration-only.

## Decisions (with rationale)
- Preserve the current generic webhook event catalogue and subscription model; Teams changes presentation/delivery only, not business-event production.
- Reuse the existing `webhooks` table and encrypted metadata unless the selected Teams transport requires fields that cannot fit its `url`, `kind`, and `metadata_encrypted` model.
- Do not connect the separate dashboard `eventBus` to webhook dispatch: no existing source path establishes that relationship.

## Scope IN
- A first-class Teams webhook integration for existing webhook events, test ping, usage-report send, delivery history, and enable/disable lifecycle.
- Dashboard wizard configuration, kind-aware validation, masked secrets, secure outbound delivery, and integration-specific tests.
- Either a Teams channel or group chat through the selected Microsoft Teams delivery mechanism.

## Scope OUT (Must NOT have)
- Legacy Office 365/Microsoft 365 Connector implementation.
- New Teams notification bot/app registration, Teams app installation lifecycle, or proactive messaging.
- Microsoft Graph delegated OAuth/token refresh unless explicitly selected.
- New webhook event types or a merger of dashboard real-time events with webhook events.
- MCP tools for webhook administration unless explicitly requested.

## Open questions
1. Choose the delivery mechanism: **Teams Workflows webhook (recommended)**, Microsoft Graph delegated OAuth, or a Teams notification bot. This changes the whole credential/onboarding surface.
2. For the first release, should admins configure only a **Teams Workflows URL** (recommended; it can target either a channel or group chat inside the flow), or must OmniRoute independently select/store the channel vs. group-chat destination? The latter requires Graph or a bot and a materially larger integration.
3. Confirm the test approach: **tests-after (recommended)**, or TDD.

## Approval gate
status: drafting
pending condition: user selects the Teams delivery/destination contract and test approach; then the planner will present the approval brief before generating the executable plan.
