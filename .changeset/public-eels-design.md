---
'@openai/agents-realtime': patch
---

Fix: ensure assistant message items from `response.output_item.done` preserve API status and default to `"completed"` when missing, so `history_updated` no longer stays `"in_progress"` after completion.
