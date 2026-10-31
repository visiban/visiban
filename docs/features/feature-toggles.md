# Switch features on or off for the whole instance

<a id="feature-toggles"></a>

> **Added in 1.0**

Site admins flip a toggle at **/admin → Settings → Features**. It takes effect within about 60 seconds, with no restart.

**Why it matters:** Toggling never deletes or alters existing data. It only gates access going forward. Use toggles to disable a feature during an incident, roll out new functionality gradually, or restrict capabilities for compliance.

## Available toggles

| Toggle | Default | Effect when off |
|---|---|---|
| **File uploads** | On | All users, including board admins, receive `403 Forbidden` when attempting to upload an attachment. Existing attachments are preserved and remain viewable and downloadable. |

New gated features will be added to this table.

<a id="who-can-change-toggles"></a>

## Managing toggles

1. Go to `/admin` (the **Site Admin** link in the sidebar).
2. Click the **Settings** tab.
3. Find the feature under **Features** and flip the toggle.

Changes take effect within about 60 seconds due to server-side caching. No restart needed.

**Who can change them:** only users with site admin status (`is_site_admin`). Board admins and members can't see instance-level toggles.

## Effect on existing data

Disabling a feature never removes data created while it was active, and re-enabling restores full access to it. For example, disabling file uploads keeps existing card attachments and just blocks new uploads.

!!! tip
    Use feature toggles to roll out new functionality gradually, to disable a feature during an incident, or to restrict capabilities on instances with specific compliance requirements.
