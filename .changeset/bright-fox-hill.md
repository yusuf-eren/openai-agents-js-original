---
'@openai/agents-extensions': patch
'@openai/agents-realtime': patch
---

Fix: clamp and floor `audio_end_ms` in interrupts to prevent Realtime API error with fractional speeds (#315)
