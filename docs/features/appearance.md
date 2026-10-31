# Pick light, dark, or follow your OS

<a id="appearance"></a>

<span class="vb-version" title="Added in 1.1">1.1+</span>

Open **Profile & preferences → Appearance** and pick one of three options: **System** (the default), **Dark**, or **Light**. It applies at once, with no reload.

**Why it matters:** The preference is stored with your account, so it follows you to every browser and device you sign in on.

**How it works:**

| Option | Behavior |
|---|---|
| **System** (default) | Follows your operating system's light/dark preference, and updates live when you change it at the OS level. |
| **Dark** | Always use the dark palette, regardless of OS preference. |
| **Light** | Always use the light palette, regardless of OS preference. |

**Yes, but:** other devices pick up the change only when they next load or reload Visiban. Already-open sessions on different devices get no live push. See [below](#changing-your-appearance).

## Changing your appearance

1. Click your avatar (top right) and select **Profile & preferences**.
2. Open the **Appearance** tab in the Settings sidebar.
3. Under **Theme**, choose an option.

The choice persists across logins and syncs instantly to other tabs in the same browser.

## System (auto) option

**System** follows your OS through the standard `prefers-color-scheme` signal. When the OS switches modes (for example, a scheduled night-shift on macOS), Visiban follows without a reload.

### macOS

1. Open **System Settings → Appearance**.
2. Choose **Light**, **Dark**, or **Auto** (switches with sunrise/sunset).

Visiban updates as soon as the setting changes.

### Windows 11

1. Open **Settings → Personalization → Colors**.
2. Under **Choose your mode**, select **Light**, **Dark**, or **Custom**.

**System** reads the app-level preference (**Choose your default app mode**, inside **Custom**), not the Windows mode.

### Linux (GNOME 42+)

1. Open **Settings → Appearance**.
2. Choose **Default** or **Dark**.

Other desktops (KDE Plasma, XFCE, Cinnamon) expose the same `prefers-color-scheme` signal; check your desktop's documentation.

## Light palette availability

**Light** is on by default in every installation. To hide it (for example, on a fork that hasn't adopted the light palette), set the build-time variable `VITE_THEME_LIGHT_ENABLED=false` when building the frontend image. **System** and **Dark** are always available.

## What's next

A custom color scheme option is under discussion in [#251](https://gitlab.com/visiban/visiban/-/issues/251), with no committed timing.
