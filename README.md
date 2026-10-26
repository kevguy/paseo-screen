# Host screen for Paseo

A [Paseo](https://paseo.sh) plugin that lets you see and control the screen of the Mac or Linux computer (or, experimentally, Windows PC) running your Paseo daemon, from any paired Paseo client: the desktop app, the web app or your phone. Think of a small TeamViewer that rides on the Paseo connection you already have, relay included, so there is no port forwarding, VPN, VNC or extra account.

It was built for the moments when an agent on a remote machine needs a human: watching a Playwright run, clicking through a permission dialog, or checking what is actually on screen.

![Controlling the host Mac from Paseo on a laptop](images/laptop-client.jpg)

## Features

- Live view of the host's screen, sized to your viewer, at roughly 5 to 15 frames per second depending on the network.
- Mouse and keyboard control: click, double-click, right-click, drag, scroll and type.
- A key bar for shortcuts your own computer keeps for itself: ⌘Tab, ⌘Space, ⌘W, ⌘Q, switching Spaces (⌃←/⌃→), Mission Control and App windows on a Mac host; Super+Tab, Activities, Apps, Ctrl+W, Alt+F4 and switching workspaces on a Linux host.
- Two-way text clipboard on desktop and web clients. ⌘V pastes your clipboard on the host, and ⌘C on the host copies back to you. With a Linux host, use Ctrl from a Windows or Linux client; a Mac client's ⌘ works there too.
- Multiple displays: each one is listed by name, the last choice is remembered, and a drag that leaves the picture continues onto the neighbouring display.
- Phones: tap to click, long-press to right-click, pinch to zoom, drag to pan, and a Rotate button that turns the picture sideways.
- Wakes the host's display when you open the viewer, and shows the lock screen if the host is locked so you can type your password to unlock it (except on GNOME Wayland, which stops sharing while locked).
- View-only mode, and Fast / Balanced / Sharp quality presets.

![Viewing the host's second display](images/desktop-viewer.jpg)

![Typing and selecting text on the host from another computer](images/remote-editing.jpg)

## Requirements

- A Mac host running macOS 14 or later, with the Xcode command line tools (`xcode-select --install`). The native helper is compiled with `swiftc` the first time it is used.
- Or a Linux host with a desktop session, either Wayland (GNOME, KDE and other desktops with xdg-desktop-portal's RemoteDesktop and ScreenCast portals) or X11, with a C compiler and the development packages for that session (see Install, step 3). The native helper is compiled with `cc` the first time it is used.
- Or, **experimentally**, a Windows 10 or 11 host. The native helper is compiled with the .NET Framework's `csc.exe`, which Windows includes, so nothing needs installing. Windows support has been tested on one Windows PC so far.
- Paseo 0.12 or later, with plugins enabled on the host.
- Any Paseo client paired with that host.

## Install

1. Enable plugins on the host by setting `"pluginsEnabled": true` in `~/.paseo/config.json`, then run `paseo reload`.
2. Install the plugin on the host from the [Paseo plugin directory](https://paseo.sh/plugins/kevguy/screen):

   ```bash
   paseo plugin add kevguy/screen
   # or straight from npm or GitHub
   paseo plugin add npm:@kevlai22/paseo-screen
   paseo plugin add git:kevguy/paseo-screen
   ```

3. Prepare the host:
   - **Mac:** open System Settings → Privacy & Security and turn on **Paseo** under both **Screen Recording** and **Accessibility**. Quit and reopen Paseo.
   - **Linux on Wayland** (the default on current Ubuntu, Fedora and GNOME): install a C compiler and the GLib, GStreamer and JPEG development packages, plus GStreamer's PipeWire plugin. The helper is compiled from source the first time the screen opens.

     ```bash
     # Debian or Ubuntu
     sudo apt install gcc pkg-config libglib2.0-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libjpeg-dev gstreamer1.0-pipewire
     # Fedora
     sudo dnf install gcc pkgconf-pkg-config glib2-devel gstreamer1-devel gstreamer1-plugins-base-devel libjpeg-turbo-devel pipewire-gstreamer
     # Arch
     sudo pacman -S gcc pkgconf glib2 gstreamer gst-plugins-base libjpeg-turbo gst-plugin-pipewire
     ```

     Wayland only lets an app see the screen and send input after the desktop asks. The first time a viewer opens, the viewer offers **Show prompt on host**, and the desktop's screen sharing dialog appears on the host. Someone at the host has to answer it once:
     - turn on **Allow Remote Interaction**. It is off by default, and without it the screen can be watched but not controlled;
     - turn on **Allow Clipboard Access** for copy and paste between your devices;
     - choose **Share**.

     The choice is remembered, so later viewers start without asking. If remote interaction was left off, **Show prompt on host** asks again. While the screen is shared, the desktop shows its sharing indicator; stopping sharing there ends it, and it stays off until someone at the host approves the dialog again. A user has to be logged in to the desktop on the host.
   - **Linux on X11:** install a C compiler and the X11 and JPEG development packages. `libxtst-dev` is the one most desktops lack: it provides XTest, which the plugin uses to send mouse and keyboard input.

     ```bash
     # Debian or Ubuntu
     sudo apt install gcc libx11-dev libxext-dev libxtst-dev libxrandr-dev libxfixes-dev libjpeg-dev
     # Fedora
     sudo dnf install gcc libX11-devel libXext-devel libXtst-devel libXrandr-devel libXfixes-devel libjpeg-turbo-devel
     # Arch
     sudo pacman -S gcc libx11 libxext libxtst libxrandr libxfixes libjpeg-turbo
     ```

     Linux hosts on X11 need no permissions. Paseo has to run inside the desktop session, which is the case for the Paseo desktop app, so the helper can reach the display. If the daemon runs some other way, see [Headless and always-on Linux hosts](#headless-and-always-on-linux-hosts).
   - **Windows (experimental):** nothing to install; the plugin compiles its helper with Windows' built-in compiler. Paseo has to run in the signed-in desktop session, as the Paseo desktop app does. Set the PC not to sleep while plugged in (see [Keep the host awake](#keep-the-host-awake)), then leave it plugged in; closing a laptop's lid should be fine as long as Windows is set not to sleep when the lid closes. Windows doesn't let normal apps see or control the lock screen, sign-in screen or UAC prompts, so those have to be handled at the PC, and apps running as administrator ignore input from the plugin.
4. In any Paseo client, open **Screen · _host name_** from the sidebar, or search "host screen" in the command center.

If a permission is missing on a Mac, the viewer says which one and offers a button that shows the macOS prompt on the host. Someone has to be at the host Mac to approve it once.

macOS gives these permissions to the app that started the Paseo daemon. That is normally the Paseo desktop app. If you run the daemon some other way, for example `paseo start` from a terminal, grant the permissions to that app (such as Terminal) instead.

## Headless and always-on Linux hosts

The plugin shares whichever desktop the Paseo daemon can reach. The Paseo desktop app runs inside your desktop session, so it shares that one. A daemon started some other way, such as a systemd user service or `paseo daemon` over SSH, picks a desktop from its environment:

- **`XDG_SESSION_TYPE=wayland`, or `WAYLAND_DISPLAY` set while `XDG_SESSION_TYPE` is not `x11`:** the Wayland desktop, through the desktop portals.
- **Otherwise, `DISPLAY` set:** that X display.
- **Neither:** the plugin asks logind for the user's graphical session and uses it if it is Wayland. An X11 session can't be found this way, because the helper needs its `DISPLAY`.

Restart the daemon after changing its environment. A daemon with only `DISPLAY=:0` set on a Wayland desktop reaches the XWayland server, which shows a black picture, so leave `DISPLAY` out for Wayland.

### Sharing the physical screen on Wayland

This works while someone is logged in to the desktop and the screen is unlocked. On a machine nobody sits at, that is hard to guarantee:

- **Logging in.** After a reboot nobody is logged in until someone signs in at the machine, and the viewer reports that there is no desktop session. Automatic login (on GNOME, Settings → System → Users) avoids that, but leaves the machine signed in for anyone who picks it up.
- **The lock screen.** GNOME ends screen sharing when the screen locks and refuses to start it while locked, so a locked GNOME host can't be unlocked from the viewer. The approval is kept: once someone unlocks the screen at the host, the next viewer resumes without a dialog. Turning off automatic screen lock (Settings → Privacy & Security → Screen Lock) keeps an unattended machine shareable, with the same trade-off.
- **Stopping sharing.** Stopping sharing from the desktop's sharing indicator drops the approval, so sharing stays off until someone at the host approves the dialog again. GNOME reports the lock only just after it ends sharing, so the plugin tells a stop from a lock 2 seconds later: stopping sharing and locking the screen within those 2 seconds counts as a lock, and sharing resumes after unlock.
- **A laptop with its lid closed** and no external monitor is untested.

### A virtual desktop for headless machines

A virtual X display avoids all of that. It needs no login, no lock screen and no approval, and it works with the lid closed or no monitor at all. It is a separate desktop, not what the physical screen shows; apps the daemon's agents open appear there too. This setup runs on an Ubuntu 26.04 home server with Xvfb and XFCE. Install `xvfb`, `xfce4` and `dbus-x11`, plus the X11 packages from Install, step 3, then add two systemd user services:

```ini
# ~/.config/systemd/user/virtual-display.service
[Unit]
Description=Virtual X display :10

[Service]
ExecStart=/usr/bin/Xvfb :10 -screen 0 1920x1080x24 +extension RANDR -nolisten tcp
Restart=always

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/virtual-desktop.service
[Unit]
Description=XFCE on the virtual display :10
Requires=virtual-display.service
After=virtual-display.service

[Service]
Environment=DISPLAY=:10
Environment=XDG_SESSION_TYPE=x11
Environment=XDG_CURRENT_DESKTOP=XFCE
UnsetEnvironment=WAYLAND_DISPLAY
ExecStartPre=/bin/sh -c "for i in $(seq 50); do [ -e /tmp/.X11-unix/X10 ] && exit 0; sleep 0.2; done; exit 1"
ExecStart=/usr/bin/dbus-run-session /usr/bin/startxfce4
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then run the Paseo daemon with `DISPLAY=:10` and `XDG_SESSION_TYPE=x11` in its environment, and without `WAYLAND_DISPLAY`. A GNOME login passes `XDG_SESSION_TYPE=wayland` and `WAYLAND_DISPLAY` to user services, and with `WAYLAND_DISPLAY` set, apps that agents start would open on the physical screen instead. For example, in its own user service:

```ini
# ~/.config/systemd/user/paseo-daemon.service
[Unit]
Description=Paseo daemon
Wants=virtual-display.service
After=network-online.target virtual-display.service

[Service]
Environment=DISPLAY=:10
Environment=XDG_SESSION_TYPE=x11
UnsetEnvironment=WAYLAND_DISPLAY
ExecStart=/opt/Paseo/resources/bin/paseo daemon run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now virtual-display virtual-desktop paseo-daemon
loginctl enable-linger "$USER"   # keep user services running without a login
```

Set `PATH` in the daemon's service too if your agent CLIs live outside the default path (for example in `~/.local/bin` or under nvm). The viewer shows no lock banner for virtual displays (Xvfb, Xvnc, Xephyr), because the session's lock screen belongs to the physical desktop, not to them.

## How it works

```
Paseo client (laptop, web, phone)                    Host (Paseo daemon)
  Host screen view  ── plugin RPC over Paseo relay ──▶  plugin server
   - polls screen.frame, two in flight                   ├─ helper #1: screen capture → JPEG
   - sends screen.input batches                          └─ helper #2: mouse and keyboard
                                                         macOS: ScreenCaptureKit and CGEvent
                                                         Linux on X11: XShm, XTest, XRandR, XFixes, libjpeg
                                                         Linux on Wayland: desktop portals, PipeWire, libjpeg
```

- `helper/main.swift` (macOS), `helper/linux.c` (Linux) and `helper/windows.cs` (Windows, experimental) are small native helpers speaking the same line-delimited JSON. The plugin server embeds all three sources, compiles the one for its platform into `~/Library/Caches/paseo-screen/<hash>/` on macOS, `~/.cache/paseo-screen/<hash>/` on Linux or `%LOCALAPPDATA%\paseo-screen\<hash>\` on Windows, and runs two copies so input never waits behind a frame capture. On Wayland one copy does both, because each process would need its own portal session and approval; it answers frames on a thread of their own.
- The Windows helper captures each monitor with GDI and sends input with `SendInput`. Keys are pressed by scan code, so they match the physical positions the other hosts use; typed text arrives as Unicode, and a Mac client's ⌘ is sent as Ctrl.
- Input carries macOS key codes, which name physical key positions. The Linux helper presses the key in the same position, and treats `cmd` as the Super key. A Mac client's ⌘ is sent as Ctrl to a Linux host, so ⌘C, ⌘V and other shortcuts do what you expect there.
- macOS grants Screen Recording and Accessibility to Paseo as the responsible app, so rebuilding the helper does not need new permissions.
- Frames are JPEGs sized to the viewer. Unchanged frames come back without image data.
- The RPCs are defined in `shared/rpc.ts`: `screen.status`, `screen.request-permissions`, `screen.frame`, `screen.input`, `screen.clipboard` and `screen.choose-display`.

## Security

Anyone paired with the host can see and control its screen while the plugin is enabled. That is the same trust that pairing already grants for running agents and terminals on that machine. Traffic stays inside the Paseo connection; the plugin opens no ports and talks to no other service. View-only mode is a setting in each viewer, not a lock on the host: any paired client can still send input. Turn the plugin off with `paseo plugin disable paseo-screen` when you don't need it.

## Keep the host awake

When the host computer goes to sleep, its Paseo daemon goes to sleep with it, so the viewer loses its connection and nothing can wake the computer through Paseo. A screen that turns off or locks is fine; the computer itself sleeping is not. Keep the host plugged in and set it not to sleep:

- **Windows:** Settings → System → Power & battery (Power on desktops) → the screen and sleep timeouts → set the **plugged in** sleep option to **Never**, and the plugged-in hibernate option too if Windows shows one. On Windows 10 it is Settings → System → Power & sleep → **Sleep** → **When plugged in, PC goes to sleep after** → **Never**. Don't choose **Sleep** from the Start menu's power button. For a laptop you close, set Control Panel → Power Options → **Choose what closing the lid does** → **When I close the lid** (Plugged in) to **Do nothing**.
- **macOS:** on a laptop, System Settings → Battery → Options → turn on **Prevent automatic sleeping on power adapter when the display is off**. On a desktop Mac such as a Mac mini, System Settings → Energy → turn on **Prevent automatic sleeping when the display is off**. A closed MacBook sleeps unless it is on power with an external display connected (some models also want an external keyboard or mouse).
- **Linux (GNOME):** Settings → Power → turn off **Automatic Suspend** when plugged in. Other desktops have a similar setting. Closing a laptop's lid usually still suspends it, so keep the lid open or change your desktop's lid setting.

Waking a sleeping computer remotely needs Wake-on-LAN: usually a wired network connection, hardware and firmware that support it, and another always-on device on the same network to send the wake signal. That is outside what the plugin can do.

## Limitations

- Mac hosts and Linux hosts on Wayland or X11 are supported. Windows hosts are experimental and have been tested on one PC so far. Any Paseo client can view. Wayland support has been tested on GNOME 50 (Ubuntu 26.04) with one display, including a 4K panel at 200% scaling; multiple displays and other Wayland desktops (KDE, Sway, Hyprland) are untested.
- On GNOME Wayland, locking the screen ends sharing, so a locked host has to be unlocked at the machine. Sharing resumes once it is unlocked. See [Headless and always-on Linux hosts](#headless-and-always-on-linux-hosts).
- On Wayland, characters the host's keyboard layout lacks (✓, emoji, é on a US layout) cannot be typed; the desktop drops them. Paste them instead (⌘V or Ctrl+V), which works for any text.
- On GNOME with display scaling, the pointer is placed with an absolute move near the corner followed by a relative move, because GNOME reads the portal's absolute positions as physical pixels. Other Wayland desktops get plain absolute moves.
- On Linux, the key bar's Activities, Apps and workspace buttons use GNOME's default shortcuts, and lock-screen detection uses `gdbus` to read logind's `LockedHint`, falling back to the GNOME or freedesktop screensaver service. Other desktops still work, but those buttons may do nothing and the viewer may not say when the host is locked.
- On Linux X11, characters outside Latin-1 (such as Cyrillic, Greek or €), and any character the host's keyboard layout lacks, are typed by briefly remapping a spare key. That takes about 30 ms per character, so paste long non-Latin text instead of typing it. Pasting with Ctrl+V does not work in terminals; use Ctrl+Shift+V (⌘⇧V from a Mac).
- It is frame polling, not video. Fast motion looks choppy, and the frame rate depends on your link to the Paseo relay.
- Granting the two macOS permissions needs someone physically at a Mac host once.
- A sleeping computer is offline: Paseo sleeps with it, so no client can reach or wake it until someone wakes it at the machine. See [Keep the host awake](#keep-the-host-awake).
- The plugin doesn't stop the host from sleeping or locking on its own schedule. Opening the viewer, using the mouse or keyboard on the picture, or the **Wake display** button wakes the display, and you unlock it by typing your password. Touch ID isn't available remotely.
- Shortcuts your own computer or the Paseo app handle first (⌘Tab, ⌘Space, ⌘W, ⌘Q) need the key bar buttons.
- Clipboard sync is text only, and only on desktop and web clients.
- Keys are sent by physical position, so both computers should use the same keyboard layout.
- No audio and no file transfer.

## Development

```bash
npm install
npm run typecheck   # also re-embeds helper/main.swift into server/helper-source.generated.ts
npm test            # rotate/zoom/pan math for the touch viewer
paseo plugin install "$PWD"           # once, from a checkout
paseo plugin reload paseo-screen      # after changes
paseo plugin logs paseo-screen
```

After editing `helper/main.swift` or `helper/linux.c`, run `npm run embed` (or `npm run typecheck`). The plugin bundle runs from memory, so the server can't read files next to itself and the helper source has to be embedded.

`scripts/` also has tools that call the plugin through a running daemon, using Paseo's CLI internals from an extracted copy of the Paseo app (`npx @electron/asar extract /Applications/Paseo.app/Contents/Resources/app.asar <dir>`):

- `rpc-probe.mjs <asar dir> <method> [json]` calls one RPC and saves frames to `build/probe-frame.jpg`.
- `frame-bench.mjs` and `pipeline-bench.mjs` measure frame latency and throughput, locally or through the relay.
- `compile-check.mjs` bundles the plugin with Paseo's own plugin compiler.

## License

[MIT](LICENSE)
