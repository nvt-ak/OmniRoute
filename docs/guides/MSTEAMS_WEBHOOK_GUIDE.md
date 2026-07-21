---
title: "Microsoft Teams Webhook Setup"
version: 3.8.47
lastUpdated: 2026-07-21
---

# Microsoft Teams Webhook Setup

> **Source of truth:** `src/lib/webhooks/integrations/msteams.ts`,
> `src/lib/webhookDispatcher.ts`, `src/lib/db/webhooks.ts`,
> `src/app/api/webhooks/`
>
> Send OmniRoute system events (request failures, quota alerts, provider errors,
> combo switches…) straight into a **Microsoft Teams channel** or **group chat**.

OmniRoute delivers Teams notifications through the modern **Workflows (Power
Automate)** incoming webhook and renders each event as an **Adaptive Card**. No
bot, no OAuth, no Graph API — just one HTTPS URL you paste into OmniRoute.

---

## ⚠️ Read this first — the classic connector is dead

Microsoft **retired Office 365 / Microsoft 365 Connectors** (the old
`*.webhook.office.com` "Incoming Webhook" URLs) in 2026. Those URLs no longer
work.

- ❌ **Do NOT use** a URL ending in `webhook.office.com` or
  `outlook.office.com/webhook`.
- ✅ **Do use** the **Workflows** webhook URL, which looks like a Logic Apps URL:
  `https://prod-XX.<region>.logic.azure.com:443/workflows/...`

The `sig` value embedded in that URL **is** the secret — treat the whole URL as
a credential (don't paste it in public logs/issues).

---

## Part 1 — Create the webhook in Microsoft Teams

You create **one Workflow per destination** (per channel or per chat). The
destination is chosen inside the Workflow, not in OmniRoute.

### Open the Workflows app and find the template

1. In Teams, open the **Workflows** app (left sidebar → **⋯ (More apps)** →
   **Workflows**; pin it for quick access).
2. Go to the **Home** (or **Templates**) tab and type **`webhook`** in the
   search box.
3. Pick the template that matches your destination:

   | Destination                                   | Template to choose                                         |
   | --------------------------------------------- | ---------------------------------------------------------- |
   | A **channel**                                 | **Send webhook alerts to a channel**                       |
   | A **group chat** (or 1:1 chat)                | **Send webhook alerts to a chat**                          |
   | Only alerts from specific senders → a channel | **Send webhook alerts from specific people to a channel**  |
   | Only alerts from your org → a channel         | **Send webhook alerts from people in an org to a channel** |

   For OmniRoute alerts, use **Send webhook alerts to a channel** (or **…to a
   chat**). You don't need the "from specific people / org" variants.

   > **Alternative entry point:** you can also start from the target channel or
   > chat directly — click **⋯ (More options)** on it → **Workflows** → search
   > `webhook` → same templates appear. Both paths create the same webhook.

### Finish creating the Workflow

4. Click the template → **Next**. Sign in / confirm the connection if prompted.
5. Select the **target team + channel** (or the **chat**) where messages should
   be posted.
6. Click **Add workflow** (or **Create**).
7. **Copy the generated webhook URL** — it looks like
   `https://prod-XX.<region>.logic.azure.com:443/workflows/...`. You'll paste it
   into OmniRoute. (You can reopen the workflow later to copy it again.)

> **Don't see any webhook template?** Some tenants restrict the Workflows app or
> specific templates. If the chat template is missing, use a channel instead —
> or ask your Teams admin to enable it. OmniRoute needs no change either way:
> the payload is identical for channel and chat.

---

## Part 2 — Add the webhook in OmniRoute

You can do this from the **dashboard** (recommended) or the **REST API**.

### Option A — Dashboard (recommended)

1. Open the dashboard → **Webhooks** (`/dashboard/webhooks`).
2. Click **Add Webhook**.
3. **Step 1 – Choose Integration:** select **Microsoft Teams**.
4. **Step 2 – Configure:** paste the **Workflow webhook URL** you copied from
   Teams. OmniRoute validates the URL live (it must be a public HTTPS URL; private
   addresses are blocked).
5. **Step 3 – Events & Test:**
   - Pick the events you want (or leave `*` for all events).
   - Click **Test** — a `test.ping` card should appear in your Teams
     channel/chat within a second or two.
   - Click **Finish**.

That's it. OmniRoute will now post an Adaptive Card to Teams for every
subscribed event.

### Option B — REST API

All webhook endpoints require **management auth** (`requireManagementAuth`).

**Create the webhook** (`kind: "msteams"`):

```bash
curl -X POST http://localhost:20128/api/webhooks \
  -H "Cookie: auth_token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "msteams",
    "url": "https://prod-XX.eastus.logic.azure.com:443/workflows/.../triggers/manual/paths/invoke?...&sig=...",
    "events": ["request.failed", "provider.error", "quota.exceeded", "combo.switched"],
    "description": "Team Teams alerts"
  }'
```

Notes:

- `kind` **must** be `"msteams"`.
- No `secret` is used for Teams — unlike custom webhooks, Teams payloads are
  **not** HMAC-signed (the `sig` in the URL is the shared secret). Any `secret`
  you pass is ignored for delivery.
- `events` accepts the literal `"*"` for all events.

**Send a test delivery:**

```bash
curl -X POST http://localhost:20128/api/webhooks/<id>/test \
  -H "Cookie: auth_token=..."
```

Returns `{ delivered, status, latencyMs, payloadSent, responseBody, error }`.

---

## What the events look like in Teams

Each event renders as an Adaptive Card with:

- A **bold title** — the event's emoji + label (e.g. `🚨 Request Failed`).
- A **FactSet** of the relevant fields present on the event
  (`Model`, `Provider`, `Combo`, `Error`, `Reason`).
- A footer line: `OmniRoute · <ISO timestamp>`.

Container color hints per event:

| Event                | Card accent     |
| -------------------- | --------------- |
| `request.completed`  | good (green)    |
| `request.failed`     | attention (red) |
| `provider.error`     | warning (amber) |
| `provider.recovered` | good (green)    |
| `quota.exceeded`     | warning (amber) |
| `usage.report`       | accent          |
| `combo.switched`     | accent          |
| `test.ping`          | accent          |

See [WEBHOOKS.md](../frameworks/WEBHOOKS.md) for the full event catalog and when
each event fires.

### Payload sent to the Workflow (for reference)

OmniRoute posts the Adaptive Card wrapped in the envelope the Workflows trigger
requires:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.5",
        "body": [
          {
            "type": "Container",
            "style": "attention",
            "bleed": true,
            "items": [
              {
                "type": "TextBlock",
                "text": "🚨 Request Failed",
                "weight": "Bolder",
                "size": "Medium",
                "wrap": true
              }
            ]
          },
          {
            "type": "FactSet",
            "facts": [
              { "title": "Model", "value": "claude-opus-4-7" },
              { "title": "Error", "value": "503 Service Unavailable" }
            ]
          },
          {
            "type": "TextBlock",
            "text": "OmniRoute · 2026-07-21T08:00:00.000Z",
            "wrap": true,
            "isSubtle": true,
            "size": "Small",
            "spacing": "Medium"
          }
        ],
        "msteams": { "width": "Full" }
      }
    }
  ]
}
```

---

## Troubleshooting

| Symptom                                               | Cause & fix                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Test returns success but nothing appears in Teams** | Teams often returns `2xx` even on failure; the real error is in the response body. Check `responseBody` from the test endpoint. Most common cause: wrong URL (a classic `webhook.office.com` connector URL that's retired) — recreate the Workflow.                          |
| **"URL is a blocked private address"**                | OmniRoute blocks non-public URLs (SSRF guard). The Workflow URL must be a public `logic.azure.com` HTTPS URL.                                                                                                                                                                |
| **Card shows but is empty / plain**                   | The Workflow isn't wired to render the Adaptive Card body. OmniRoute always sends the correct `type: "message"` + `attachments` envelope, so recreate the workflow from the **Send webhook alerts to a channel/chat** template (its default action renders the posted card). |
| **Notifications stopped after a while**               | The webhook may be auto-disabled after 10 consecutive failures (`failure_count >= 10`). Re-enable via the dashboard toggle or `PUT /api/webhooks/<id>` with `{"enabled": true}` after fixing the URL.                                                                        |
| **Some events never fire**                            | Not every event has a production call site yet — see the note in [WEBHOOKS.md](../frameworks/WEBHOOKS.md). `test.ping` always works; use it to confirm connectivity.                                                                                                         |
| **429 / throttled**                                   | Teams throttles above ~4 requests/second. If you subscribe a very high-volume webhook to `*`, narrow the `events` list.                                                                                                                                                      |

---

## Limits & behavior (Teams-specific)

- **Payload cap:** Teams limits messages to ~28 KB. OmniRoute truncates
  free-form field values (to ~512 chars) so a single event stays well under the
  limit.
- **Rate limit:** ~4 requests/second per webhook on the Teams side.
- **No HMAC:** Teams deliveries are not signed by OmniRoute (unlike `custom`
  webhooks). The Workflow URL's `sig` is the trust boundary — keep the URL
  secret.
- **Success detection:** delivery is recorded from the HTTP status. Because
  Teams can return `2xx` on soft failures, treat "delivered" as
  "accepted for processing", not a guarantee it rendered.
- **Best-effort delivery:** Teams payloads use the raw delivery path (no
  automatic retry/backoff), matching the Slack/Discord integrations.

---

## See Also

- [WEBHOOKS.md](../frameworks/WEBHOOKS.md) — full webhook event catalog, dispatch
  architecture, DB schema, and REST API.
- Source: `src/lib/webhooks/integrations/msteams.ts` — the Adaptive Card builder.
- Microsoft docs: _Create incoming webhooks with Workflows for Microsoft Teams_
  and _Send Adaptive Cards using an Incoming Webhook_ (Microsoft Learn).
