import "@copilotkit/react-native/polyfills";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SettingsProvider } from "../lib/settings";
import { colors } from "../lib/theme";

const RootLayout = () => (
  <GestureHandlerRootView style={{ flex: 1 }}>
    <SettingsProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Projekty" }} />
        <Stack.Screen name="settings" options={{ title: "Połączenie z serwerem" }} />
        <Stack.Screen name="projects/[id]" options={{ title: "Projekt" }} />
      </Stack>
    </SettingsProvider>
  </GestureHandlerRootView>
);

export default RootLayout;
