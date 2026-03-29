# Security Audit: Headless Allauth + OAuth Edge Cases (#370)

**Date:** 2026-03-29
**Scope:** All auth endpoints, OAuth flows, session management, password reset, account linking
**Auditor:** Automated + manual review

## Summary

No critical or high-severity vulnerabilities were found. Four medium/low findings were identified and fixed in the same MR. One informational finding was deferred to #470.

## Findings

### Fixed in this MR

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| M-1 | Medium | `PATAuthentication` did not check `user.is_active` — deactivated users could retain API access via previously issued tokens | Added `is_active` check in `authentication.py`; also delete all PATs on user deactivation in `AdminUserDeactivateView` |
| M-2 | Medium | `ChangePasswordView` and `AdminCreateUserSerializer` only enforced 12-char minimum, bypassing Django's `AUTH_PASSWORD_VALIDATORS` (CommonPasswordValidator, NumericPasswordValidator, UserAttributeSimilarityValidator) | Added `password_validation.validate_password()` calls in both code paths |
| L-1 | Low | `AdminIPRestrictionMiddleware` trusted leftmost X-Forwarded-For entry (client-supplied) instead of rightmost (proxy-appended), inconsistent with DRF's `NUM_PROXIES=1` | Changed to rightmost entry |
| L-2 | Low | No explicit `ACCOUNT_RATE_LIMITS` for login brute-force — relied on allauth version defaults | Added `ACCOUNT_RATE_LIMITS = {"login_failed": "5/300s"}` |

### Deferred

| ID | Severity | Finding | Tracking |
|----|----------|---------|----------|
| I-1 | Info | Multi-use invite links have no usage counter for audit visibility | #470 |

## Checklist (from issue #370)

- [x] All allauth endpoints are mapped and gated correctly
- [x] `state` validation confirmed on OAuth callbacks (handled by allauth internally)
- [x] Account linking does not auto-connect by email (`SOCIALACCOUNT_EMAIL_AUTHENTICATION=False`)
- [x] Tokens are invalidated on logout (session flushed server-side)
- [x] Password reset tokens are time-limited (Django default 3 days) and invalidated after use (password hash change invalidates the token)
- [x] No email enumeration via reset flow (`EMAIL_UNKNOWN_ACCOUNTS=True` sends unknown-account email)
- [x] Findings documented; follow-up issue opened (#470)

## Auth Surface Map

### Session Security
- Session-based auth only (`USE_JWT=False`)
- `httpOnly` cookies (Django default), `Secure` in production, `SameSite=Lax`
- No localStorage for auth credentials
- CSRF enforced via `CsrfViewMiddleware` + `SessionAuthentication`

### PAT Security
- SHA-256 hashed storage, raw value shown once at creation
- `vbn_` prefix for identification
- Expiry enforced, `is_active` check enforced (after this fix)
- All PATs revoked on password change and user deactivation (after this fix)

### OAuth Security
- State parameter validated by allauth (CSRF protection)
- Token exchange server-side only (no client-side token exposure)
- Redirect targets fixed to `FRONTEND_URL` (no open redirect)
- Registration mode enforced in adapter (`is_open_for_signup`)
- INVITE_ONLY mode blocks OAuth signup entirely

### Rate Limiting
- Login: 5 failed attempts per 5 minutes (explicit, after this fix)
- Registration: 10/min
- User search: 30/min
- Anonymous: 300/hour
- Choose username: 10/min

### Admin Protection
- IP restriction middleware (rightmost X-Forwarded-For, after this fix)
- `IsSiteAdmin` permission on all admin endpoints
- Self-deactivation and last-admin-demotion guards
