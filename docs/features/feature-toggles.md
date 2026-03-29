# Feature Toggles


Site admins can enable or disable specific features across the entire instance from the admin panel. Toggling a feature does not delete or alter any existing data — it only gates access to that functionality going forward.

## Managing toggles

1. Go to `/admin` (accessible via the **Site Admin** link in the sidebar).
2. Click the **Settings** tab.
3. Find the feature under the **Features** section and flip the toggle.

Changes take effect within approximately 60 seconds due to server-side caching. No restart is required.

## Available toggles

| Toggle | Default | Effect when off |
|---|---|---|
| **File uploads** | On | All users, including board admins, receive `403 Forbidden` when attempting to upload an attachment. Existing attachments are preserved and remain viewable and downloadable. |

Additional toggles will appear in this table as new gated features are introduced.

## Who can change toggles

Only users with site admin status (`is_site_admin`) can access the admin panel Settings tab. Board admins and members have no visibility into instance-level feature toggles.

## Effect on existing data

Disabling a feature never removes data created while the feature was active. Re-enabling it restores full access to that data. For example, disabling file uploads does not delete existing card attachments — it prevents new uploads until re-enabled.

!!! tip
    Use feature toggles to roll out new functionality gradually, to disable a feature during an incident, or to restrict capabilities on instances with specific compliance requirements.
