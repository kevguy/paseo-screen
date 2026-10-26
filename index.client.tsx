import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text } from "react-native";
import { useControlPause } from "./client/control";
import { RemoteScreen } from "./client/screen";

function ScreenItem({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  // The pause button lets someone at the host (or anyone paired) stop remote input without opening the viewer.
  const control = useControlPause(host.id);
  const label = control.paused ? "Resume remote control" : "Pause remote control";
  // Every host with the plugin installed adds its own row, so name the host.
  return (
    <SidebarRow
      icon="Monitor"
      label={`Screen · ${host.label}${control.paused ? " (control paused)" : ""}`}
      active={currentScreen?.screenId === "screen"}
      onPress={() => openScreen({ screenId: "screen" })}
      trailing={
        control.known ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            // Not `disabled`: a disabled button passes the press to the row, which would open the viewer.
            onPress={() => {
              if (!control.changing) control.setPaused(!control.paused);
            }}
            style={{ paddingHorizontal: 8, paddingVertical: 4 }}
          >
            <Text style={{ color: control.paused ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 13 }}>
              {control.paused ? "▶" : "⏸"}
            </Text>
          </Pressable>
        ) : null
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "screen", title: "Host screen", Component: RemoteScreen }),
    client.addSidebarHeaderItem({ id: "screen", title: "Host screen", Component: ScreenItem }),
    client.addCommandCenterItem({
      id: "open-screen",
      title: "Show host screen",
      icon: "Monitor",
      keywords: ["remote", "screen", "desktop", "vnc", "control"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "screen" }),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
