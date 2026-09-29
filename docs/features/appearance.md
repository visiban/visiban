# Appearance

> **Added in 1.1**

Visiban offers a per-user appearance preference with three options.

| Option | Behavior |
|---|---|
| **System** (default) | Follows your operating system's light/dark preference, and updates live when you change it at the OS level. |
| **Dark** | Always use the dark palette, regardless of OS preference. |
| **Light** | Always use the light palette, regardless of OS preference. |

The preference is stored with your account, so it follows you to every browser and device you sign in on — see [below](#changing-your-appearance) for when it takes effect.

## Changing your appearance

1. Click your avatar in the top-right corner and select **Profile & preferences**.
2. Open the **Appearance** tab in the Settings sidebar.
3. Under **Theme**, choose one of the three options.
4. The change takes effect immediately — no page reload.

Your choice is remembered across logins and syncs instantly to any other tab in the same browser. It reaches your other browsers and devices the next time each one loads or reloads Visiban — there's no live push between already-open sessions on different devices.

## System (auto) option

**System** follows your operating system's appearance preference via the standard `prefers-color-scheme` signal. When your OS switches modes (e.g. a scheduled night-shift on macOS), Visiban picks it up without a page reload.

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

**Light** is available by default in every Visiban installation.

Administrators who want to hide it — for example, on an install-specific fork that hasn't adopted the light palette — can set the build-time environment variable `VITE_THEME_LIGHT_ENABLED=false` when building the frontend image. **System** and **Dark** are always available regardless.

## What's next

A custom color scheme option is under discussion in [#251](https://gitlab.com/visiban/visiban/-/issues/251), with no committed timing.
