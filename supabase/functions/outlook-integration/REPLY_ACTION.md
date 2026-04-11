# Add `reply_to_email` action to outlook-integration

Add this case to the action switch statement in the outlook-integration Edge Function.
This uses the Microsoft Graph API reply endpoint to send a proper threaded reply.

## Code to add

Add this case alongside the existing `send_email`, `search_emails`, and `get_email_thread` cases:

```typescript
// ── reply_to_email ──
if (action === "reply_to_email") {
  const { email_id, body: replyBody } = requestBody;

  if (!email_id) {
    return new Response(JSON.stringify({ error: "email_id is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (!replyBody) {
    return new Response(JSON.stringify({ error: "body is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Use the same Microsoft token and mailbox as other actions
  const replyUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(email_id)}/reply`;

  const replyResponse = await fetch(replyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${msToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      comment: replyBody,
    }),
  });

  if (!replyResponse.ok) {
    const errText = await replyResponse.text();
    console.error("Graph API reply error:", replyResponse.status, errText);
    return new Response(JSON.stringify({ error: `Reply failed: ${replyResponse.status}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
```

## What this does

- Calls `POST /users/{mailbox}/messages/{email_id}/reply` on the Microsoft Graph API
- The `comment` field is the reply text — Graph API handles threading, quoting, and conversation grouping automatically
- The reply goes out from the same mailbox used for all other email operations
- Uses the same auth token (`msToken`) and `mailbox` variable already available in the function

## Deploy

```bash
npx supabase functions deploy outlook-integration --no-verify-jwt
```
