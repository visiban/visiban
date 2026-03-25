# API Reference

Visiban exposes a REST JSON API. All endpoints require an authenticated session unless noted otherwise.

**Base URL:** `http://localhost:8000` (dev) or your configured domain (production)

| Reference | Description |
|---|---|
| [Authentication](authentication.md) | Login, logout, OAuth flows, session auth, Personal Access Tokens (PATs) |
| [Boards API](boards.md) | Boards, columns, swimlanes, labels, and board member management |
| [Cards API](cards.md) | Cards, move endpoint, comments, attachments, checklists, and activity |
| [Groups API](groups.md) | Groups, subgroups, group members, and invite links |
| [Notifications API](notifications.md) | List unread notifications, mark as read, and get unread count |
| [Health Checks](health.md) | Liveness and readiness probes for K8s / uptime monitoring |
| [OpenAPI Spec](openapi.md) | Machine-readable OpenAPI 3.0 spec, Swagger UI, and ReDoc |

## Common conventions

- All endpoints return `application/json`
- Write endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) require a valid CSRF token or use token-based auth
- Dates are ISO 8601 strings: `"2026-04-01"`
- Permission errors return `403 Forbidden`; missing resources return `404 Not Found`
