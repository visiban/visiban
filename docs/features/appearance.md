# Appearance

> **Added in 1.1**

Visiban supports a per-user appearance preference with three options:

| Option | Behavior |
|---|---|
| **System** (default) | Follows your operating system's light/dark preference, and updates live when you change it at the OS level. |
| **Dark** | Always use the dark palette, regardless of OS preference. |
| **Light** | Always use the light palette, regardless of OS preference. |

The preference is stored per user and synchronises across every device you are logged into.

## Changing your appearance

1. Click your avatar in the top-right corner and open **Settings**.
2. Under **Appearance**, choose one of the three options.
3. The change takes effect immediately — no page reload.

Your choice is remembered across logins and propagates to other browsers and devices within a few seconds.

## System (auto) option

The **System** option follows your operating system's appearance preference via the standard `prefers-color-scheme` signal. When your OS switches modes (e.g. a scheduled night-shift on macOS), Visiban picks it up without a page reload.

### macOS

1. Open **System Settings → Appearance**.
2. Choose **Light**, **Dark**, or **Auto** (switches automatically with sunrise/sunset).
3. Visiban updates as soon as the setting changes — no action needed in the browser.

### Windows 11

1. Open **Settings → Personalization → Colors**.
2. Under **Choose your mode**, select **Light**, **Dark**, or **Custom**.
3. Visiban's **System** option reads the app-level preference (the **Choose your default app mode** setting inside **Custom**), not the Windows mode.

### Linux (GNOME 42+)

1. Open **Settings → Appearance**.
2. Choose **Default** or **Dark**.

Other desktop environments (KDE Plasma, XFCE, Cinnamon) expose the same `prefers-color-scheme` signal through their respective appearance settings; check your desktop's documentation for details.

## Light palette availability

The **Light** option is available by default in every Visiban installation.

Administrators who wish to hide the Light option — for example, on an install-specific fork that has not adopted the light palette — can set the build-time environment variable `VITE_THEME_LIGHT_ENABLED=false` when building the frontend image. The **System** and **Dark** options are always available regardless.

## What's next

Two related enhancements are tracked on the roadmap but are not part of the initial light-theme release:

- **User-picked accent colors** — choose a custom accent color used for primary actions and active states, independent of light/dark.
- **Admin-configured install-wide palettes** — instance administrators will be able to brand Visiban with a custom palette that applies to all users.

Both are scheduled as independent features; see the project issue tracker for timing.
