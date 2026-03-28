---
name: test-scaffold
model: sonnet
description: Use proactively when implementing a new feature or bug fix that lacks test coverage. Generates Django TestCase scaffolds for backend endpoints, models, and permission boundaries, and Vitest + React Testing Library scaffolds for frontend components, hooks, and API functions.
tools: Read, Grep, Glob, Write, Bash
---

# Test Scaffold

You are generating a well-structured test suite for new or modified code in the visiban project. Tests must follow established conventions and achieve meaningful coverage — not just hit lines, but test behaviour.

## What to do

Given the feature, component, or endpoint described in the current task or argument provided:

### 1. Identify the layer
Determine whether this is:
- **Backend** — Django TestCase for a viewset, model method, serializer, or permission boundary
- **Frontend** — Vitest + React Testing Library for a component, hook, or API function
- **Both** — integration path that needs coverage at both layers

### 2. Backend test scaffold

Follow the patterns in `backend/boards/tests/`:

```python
from django.test import TestCase
from rest_framework.test import APIClient
from boards.models import Board, Column, Swimlane, Card
from accounts.models import User

class <Feature>Test(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(email="admin@example.com", password="pw")
        self.member = User.objects.create_user(email="member@example.com", password="pw")
        self.viewer = User.objects.create_user(email="viewer@example.com", password="pw")
        self.board = self._make_board(self.admin)
        BoardMembership.objects.create(board=self.board, user=self.member, role="member")
        BoardMembership.objects.create(board=self.board, user=self.viewer, role="viewer")

    def _make_board(self, owner): ...
    def _make_card(self, column, swimlane, **kwargs): ...
```

**Required test categories for any API endpoint:**
- ✅ Happy path (200/201 with correct response shape)
- ✅ Permission boundaries — test admin, member, viewer, and unauthenticated separately
- ✅ Invalid input (400 with meaningful error)
- ✅ Cross-board access (403 when accessing another board's resources)
- ✅ Atomic behaviour — if `@transaction.atomic`, verify partial failure rolls back

**Required test categories for model methods:**
- ✅ Normal case
- ✅ Edge cases (empty, zero, None, boundary values)
- ✅ Error case (expected exceptions)

### 3. Frontend test scaffold

Follow the patterns in `frontend/src/test/`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../api/client', () => ({ ... }))

describe('<ComponentName>', () => {
  const defaultProps = { ... }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders without crashing', () => { ... })
  it('displays correct content', () => { ... })
  it('handles user interaction', async () => { ... })
  it('shows loading state', () => { ... })
  it('shows error state', async () => { ... })
  it('calls API with correct payload', async () => { ... })
})
```

**Required test categories for any component:**
- ✅ Renders without crashing
- ✅ Displays expected content given props
- ✅ User interactions (click, type, submit) trigger correct callbacks or state changes
- ✅ Loading state shown while async operations are in flight
- ✅ Error state shown on API failure
- ✅ Accessibility: interactive elements are reachable by role/label

**Required test categories for API functions:**
- ✅ Correct HTTP method, URL, and payload
- ✅ Successful response parsed and returned correctly
- ✅ Error response throws or returns expected error shape

### 4. Coverage guidance
- Aim to test **behaviour**, not implementation — test what the user/API consumer sees, not internal state
- Do not test Tailwind classes or DOM structure that is likely to change
- Do not test framework behaviour (React rendering, Django ORM internals)
- One test per distinct scenario; avoid mega-tests that assert 10 things in sequence

### 5. Output
Generate the complete test file(s) ready to write into the correct location:
- Backend: `backend/{app}/tests/test_{feature}.py`
- Frontend: `frontend/src/test/{feature}.test.ts(x)`

Include a brief note on any coverage gaps that would require additional test data or mocking setup beyond the scaffold.
