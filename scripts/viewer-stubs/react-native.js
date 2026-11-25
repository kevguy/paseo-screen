// The few React Native exports the viewer uses, as plain host elements for react-test-renderer.
export const View = "View", Text = "Text", Image = "Image", Pressable = "Pressable", ScrollView = "ScrollView", TextInput = "TextInput";
export const Platform = { get OS() { return globalThis.viewerOS; } };
export const PixelRatio = { get: () => 2 };
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
export const Dimensions = { get: () => ({ width: 400, height: 800 }), addEventListener: () => ({ remove() {} }) };
export const Keyboard = { addListener: () => ({ remove() {} }) };
export const NativeModules = {};
export const TurboModuleRegistry = { get: () => null };
export const PanResponder = { create: (config) => ({ panHandlers: { gesture: config } }) };
